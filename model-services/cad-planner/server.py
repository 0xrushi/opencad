"""Private planner: turns a CAD request plus the user's selection into symbolic operations.

The model never produces coordinates. It names faces and edges (F3, E5) and
geometric relations; CADAM resolves those to numbers and the CAD kernel runs them.
"""

import json
import re
from threading import Lock
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from transformers import AutoModelForCausalLM, AutoTokenizer

BASE = "/models/base/Meta-Llama-3-8B-Instruct"
app = FastAPI(title="CADAM CAD planner")
lock = Lock()
state: dict[str, Any] = {"ready": False}

SYSTEM = """You convert a user's CAD request into JSON operations for a geometry kernel.
Reply with ONE JSON object and nothing else.

{"intent": "ops" | "measure" | "mark" | "marker" | "model" | "clarify", "message": string, "ops": [ ... ], "measure": {...}, "mark": {...}, "marker": {...}}

intent "ops": the request can be done exactly with the operations below.
intent "measure": the user asks a question about the geometry (a size, radius, length, area, distance or
  position) and wants an answer, not a change. ops must be [] and measure must be
  {"what":"radius"|"diameter"|"length"|"area"|"distance"|"center"|"angle"|"thickness","of":[REF,...]} naming the selected items
  (angle: two faces or edges; thickness: the wall behind a face), or about the whole part with "of":[]:
  {"what":"volume"|"surface_area"|"bbox"|"holes"|"printability"|"mass"} ("mass" also takes "material": the word the
  request uses, or null; "printability" may take "threshold": the minimum wall from the request).
intent "mark": the user wants to PREVIEW a spot, patch or marker on a planar face (for example "draw a 5 circle
  at the center of the selected face" or "mark a spot 2 from the left edge"). ops must be [] and
  mark = {"face":REF,"shape":"circle","diameter":number|null,"at":AT} where
  diameter is null when the user gives no size ("a dot", "a spot", "a point"), and
  AT = {"center":true} | {"offsets":[{"from":SIDE,"distance":number}, ...]} (one or two entries) and
  SIDE is "left","right","front","back","top","bottom", an edge REF like "E3", or "shorter_edge" /
  "longer_edge" (the shorter or longer of the two selected edges). Distances are measured within the
  face from that side or edge. Never ask for a size that "a dot/spot/point" does not need.
intent "marker": the context says a marker is currently placed and the user responds to it: confirm
  ("drill it", "looks good, go ahead", "drill it 0.02 deep") -> marker {"action":"drill","depth":number|null},
  or discard ("remove it", "cancel") -> marker {"action":"clear","depth":null}. If no marker is placed use clarify.
intent "model": the request adds or reshapes features in a way these operations cannot express
  (for example "make it look like a bracket", "design a new part"); ops must be [].
intent "clarify": ONLY when the request is ambiguous or the faces/edges it needs are NOT in the selection; put one short
  question in "message"; ops must be [].

OPERATIONS (numbers are in model units; the part size is given):
{"op":"cut","plane":PLANE,"keep":KEEP}      split the part by a plane
{"op":"hole","face":REF,"diameter":QTY,"depth":number|null,"at":POINT}   round hole (at the face centre unless "at" is given), depth null = through
  optional: "style":"counterbore"|"countersink" with "head_diameter","head_depth" (counterbore) or "angle" (countersink, default 90);
  or give "metric":"M3","fit":"clearance"|"tap" instead of "diameter" when the request names a screw size (standard head sizes are used)
{"op":"pocket","face":REF,"at":POINT,"profile":PROFILE,"depth":number|null,"rotation":deg}  cut a rectangle/circle/slot/polygon/ellipse/rounded_rect/star into a face (depth null = through)
{"op":"boss","face":REF,"at":POINT,"profile":PROFILE,"height":number,"rotation":deg}  raise a rectangle/circle/slot/polygon/ellipse/rounded_rect/star out of a face
  PROFILE: {"shape":"rect","width":w,"height":h} | {"shape":"circle","diameter":d} | {"shape":"slot","width":length,"height":slot width} | {"shape":"polygon","sides":n,"width":distance across flats} | {"shape":"ellipse","width":w,"height":h} | {"shape":"rounded_rect","width":w,"height":h,"radius":corner radius} | {"shape":"star","sides":points,"width":outer diameter}
  hexagon = polygon with sides 6, pentagon 5, octagon 8, triangle 3. Never use "hexagon" as a shape name.
{"op":"text","face":REF,"at":POINT,"text":"quoted from request","size":number,"depth":number,"mode":"emboss"|"engrave"}
{"op":"pattern","of":HOLE|POCKET|BOSS|TEXT op,"kind":"linear","count":n,"spacing":d,"direction":"+X"|{"edge":REF}}  repeat it in a line
{"op":"pattern","of":...,"kind":"circular","count":n,"around":"x"|"y"|"z"|REF,"angle":deg}  repeat it around an axis or a round hole/boss
{"op":"shell","thickness":number,"open":[REF faces]}   hollow the part with walls of that thickness, leaving those faces open
{"op":"offset_face","face":REF,"distance":number}   move a flat face outward (+) or inward (-)
{"op":"remove","targets":[REF,...]}   remove / delete / erase a boss, hole, pocket, fillet or chamfer (select one of its faces or edges);
  the kernel decides whether to fill a cavity or take off a protrusion
{"op":"rib","edge":REF,"at":POINT,"thickness":number,"size":number}   triangular gusset in the corner edge between two flat faces
{"op":"draft","faces":[REF,...],"angle":deg,"pull":"+Z"}   taper side walls by angle degrees about a pull direction
{"op":"combine","mode":"union"|"subtract"|"intersect","version":n}   boolean with saved version n (the context says how many exist)
{"op":"fillet","edges":[REF,...],"radius":number}
{"op":"chamfer","edges":[REF,...],"distance":number}
{"op":"stretch","between":[REF,REF],"distance":number}   make two parallel faces farther apart (positive) or closer (negative)
{"op":"fill","targets":[REF,...]}   fill/plug/close/flatten ANY cavity with solid material: a hole, slot, pocket,
  recess, groove, notch or undercut. targets are the selected faces or edges of that cavity (walls, floor, rim);
  the kernel finds the rest of the cavity itself, so one selected item is enough
{"op":"scale","factor":number}
{"op":"translate","vector":[x,y,z]}
{"op":"mirror","plane":PLANE}                add a mirror copy across a plane

REF is "F3" (face), "E5" (edge) or "V2" (corner) from the selection or face list, or {"facing":"+Z"} for the largest
planar face pointing that way. top=+Z, bottom=-Z, front=-Y, back=+Y, right=+X, left=-X.

PLANE is one of:
{"kind":"face","face":REF}                              the plane of a planar face
{"kind":"through_edges","edges":[REF,REF]}              plane containing two straight edges
{"kind":"parallel_to_face","face":REF,"through":POINT}  plane with that face's normal passing through POINT
{"kind":"axis","axis":"x"|"y"|"z","at":"center"|number} plane perpendicular to an axis
{"kind":"through_points","points":[POINT,POINT,POINT]}   plane through three points (corners, edge points, ...)
{"kind":"edge_and_point","edge":REF,"point":POINT}       plane containing a straight edge and a point
{"kind":"edge_at_angle","edge":REF,"face":REF,"angle":deg}  plane through a straight edge tilted by angle degrees from
  the plane of a planar face (0 = parallel to that face)
{"kind":"tangent_to_face","face":REF,"side":"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z"}  plane touching a round (cylindrical) face on that side
{"kind":"through_axis","of":REF,"direction":"+X"|...}  plane containing the axis of a hole/round face and that direction
{"kind":"middle_of","of":[REF,...],"axis":"x"|"y"|"z"}  plane perpendicular to the axis, midway across those faces/edges/corners
{"kind":"rotated","base":PLANE,"about":"x"|"y"|"z"|EDGE,"angle":deg}  a plane turned by angle degrees about an axis or a straight edge
{"kind":"across_edge","edge":REF,"through":POINT}       plane perpendicular to an edge (crossing it), through POINT;
  use it for "bisect E4", "perpendicular to E4", "across E4", "cross-section of E4". Omit "through" for the
  edge's midpoint.
{"kind":"offset","base":PLANE,"distance":number,"direction":"+X"|"-X"|"+Y"|"-Y"|"+Z"|"-Z"}
  a plane moved by distance from another plane. Direction words: left=-X, right=+X,
  front or "in front of"=-Y, back or behind=+Y, up/above/top=+Z, down/below/bottom=-Z.
  When the request says "toward -Y" (or any axis), use exactly that direction.

POINT is one of: {"vertex":REF} | {"along":EDGE,"fraction":0..1} | {"along":EDGE,"distance":d,"from":"start"|"end"|VREF}
  | {"center_of":REF} (centre of a round edge or hole face) | {"edge":REF} | {"face":REF} | {"midway":[REF,REF]} | {"center":true}
  "midway" is the midpoint between two references; "center" is the part's centre.

KEEP for cut is "split" (both halves, moved apart), a direction like "+Z", or a face REF meaning
"keep the side containing that face". Default "split".

A size (hole diameter, fillet radius, chamfer distance) is a number from the request, or {"same_as":REF,"what":"diameter"|"radius"}
when the request says "same size as", "same diameter as" or "matching" an existing hole or round edge.
"30%" along an edge is fraction 0.3. A corner is V2 and is selected like faces and edges.

Rules: for any request to fill, plug, close, flatten or make something flush, when ANY face or edge is selected, output
exactly one fill op whose targets are the selected face and edge ids, and nothing else (fill already leaves the surface
flush; never add a cut or other operation unless the user asks for it). If no listed operation can express the request, use intent "model" or "clarify"; NEVER force the closest
operation (for example, do not turn "extend the distance between two faces" into a cut). Use only references that appear in the selection or the face list. When faces or edges are selected,
NEVER ask the user to select them again; plan with the selected ids. If the user says "the
selected faces/edges" use the selected ids. Never invent coordinates. Multi-step requests become
several ops in order. Output valid JSON only."""

EXAMPLES = [
    (
        "Part size 1.8. Selected: E10 straight edge (-0.91,-0.29,-0.14)->(0.91,-0.29,-0.14); F10 planar +Y centre (-0.1,0.28,0.0).\nRequest: cut by a plane parallel to F10 and between E10 and F10",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "parallel_to_face", "face": "F10", "through": {"midway": ["E10", "F10"]}}, "keep": "split"}]},
    ),
    (
        "Part size 1.0. Selected: F1 planar +Z; F12 planar -Z.\nRequest: cut between the 2 selected planes in the middle",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "parallel_to_face", "face": "F1", "through": {"midway": ["F1", "F12"]}}, "keep": "split"}]},
    ),
    (
        "Part size 1.0. Selected: F4 planar +Z centre (0,0,0.1).\nRequest: drill a hole 0.2 wide through the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "hole", "face": "F4", "diameter": 0.2, "depth": None}]},
    ),
    (
        "Part size 2.0. Selected: E3 straight; E7 straight; E8 straight.\nRequest: round these edges with a 0.05 fillet",
        {"intent": "ops", "message": "", "ops": [{"op": "fillet", "edges": ["E3", "E7", "E8"], "radius": 0.05}]},
    ),
    (
        "Part size 1.7. Selected: E1 straight edge; E2 straight edge.\nRequest: make a plane through the two selected edges, shift it 0.08 to the right and split there",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "offset", "base": {"kind": "through_edges", "edges": ["E1", "E2"]}, "distance": 0.08, "direction": "+X"}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: E4 straight edge; E6 straight edge.\nRequest: take the plane through the selected edges, move it 0.2 in front of it and cut there keeping the back part",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "offset", "base": {"kind": "through_edges", "edges": ["E4", "E6"]}, "distance": 0.2, "direction": "-Y"}, "keep": "+Y"}]},
    ),
    (
        "Part size 2.0. Selected: F2 curved face centre (0,-0.5,0); E4 straight edge (-1,-0.5,0.2)->(1,-0.5,0.2).\nRequest: draw a plane passing through the middle of F2 and bisecting E4 and cut it there",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "across_edge", "edge": "E4", "through": {"face": "F2"}}, "keep": "split"}]},
    ),
    (
        "Part size 1.0. Selected: E2 straight edge.\nRequest: cut perpendicular to this edge at its middle",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "across_edge", "edge": "E2"}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: V1 corner (1,-0.5,0.2); V4 corner (-1,-0.5,0.2); F3 planar face facing +Z.\nRequest: cut parallel to the top through the middle between the selected corners",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "parallel_to_face", "face": "F3", "through": {"midway": ["V1", "V4"]}}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: E4 straight edge (-1,-0.5,0.2)->(1,-0.5,0.2).\nRequest: cut across this edge 30% along from its start",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "across_edge", "edge": "E4", "through": {"along": "E4", "fraction": 0.3, "from": "start"}}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: F5 planar face facing +Z; E9 circular edge, centre (0.5,0,0.2), radius 0.1.\nRequest: drill a hole in the selected face with the same diameter as E9",
        {"intent": "ops", "message": "", "ops": [{"op": "hole", "face": "F5", "diameter": {"same_as": "E9", "what": "diameter"}, "depth": None}]},
    ),
    (
        "Part size 2.0. Selected: V1 corner (1,-0.5,0.2); V4 corner (-1,0.5,0.2); V6 corner (1,0.5,-0.2).\nRequest: cut through the three selected corners",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "through_points", "points": [{"vertex": "V1"}, {"vertex": "V4"}, {"vertex": "V6"}]}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: E4 straight edge (-1,-0.5,0.2)->(1,-0.5,0.2); F3 planar face facing +Z.\nRequest: cut along this edge at 45 degrees to the top face",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "edge_at_angle", "edge": "E4", "face": "F3", "angle": 45}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: F7 curved face centre (0.5,0,0).\nRequest: cut with a plane touching the right side of the round face",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "tangent_to_face", "face": "F7", "side": "+X"}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: F7 curved face centre (0.5,0,0).\nRequest: make a section through the axis of this hole going front to back",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "through_axis", "of": "F7", "direction": "+Y"}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: F3 planar face facing +X; F8 planar face facing +X.\nRequest: cut in the middle between the selected faces",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "middle_of", "of": ["F3", "F8"], "axis": "x"}, "keep": "split"}]},
    ),
    (
        "Part size 2.0. Selected: none.\nRequest: cut with the middle plane turned 30 degrees about the z axis",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "rotated", "base": {"kind": "axis", "axis": "x", "at": "center"}, "about": "z", "angle": 30}, "keep": "split"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z, centre (0,0,5).\nRequest: cut a 10 by 6 rectangular pocket 3 deep in the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "pocket", "face": "F2", "profile": {"shape": "rect", "width": 10, "height": 6}, "depth": 3}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z, centre (0,0,5).\nRequest: cut a hexagonal pocket 8 across the flats and 3 deep in the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "pocket", "face": "F2", "profile": {"shape": "polygon", "sides": 6, "width": 8}, "depth": 3}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: cut a 5 point star 12 across, 2 deep, into the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "pocket", "face": "F2", "profile": {"shape": "star", "sides": 5, "width": 12}, "depth": 2}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: raise an oval boss 10 by 6 and 3 tall on the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "boss", "face": "F2", "profile": {"shape": "ellipse", "width": 10, "height": 6}, "height": 3}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: cut a 12 by 8 rectangular pocket with 2 radius corners, 3 deep",
        {"intent": "ops", "message": "", "ops": [{"op": "pocket", "face": "F2", "profile": {"shape": "rounded_rect", "width": 12, "height": 8, "radius": 2}, "depth": 3}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: add a round boss 6 wide and 4 tall on the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "boss", "face": "F2", "profile": {"shape": "circle", "diameter": 6}, "height": 4}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: drill an M3 countersunk hole here",
        {"intent": "ops", "message": "", "ops": [{"op": "hole", "face": "F2", "metric": "M3", "fit": "clearance", "style": "countersink", "depth": None}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: drill a 4 hole with an 8 counterbore 2 deep",
        {"intent": "ops", "message": "", "ops": [{"op": "hole", "face": "F2", "diameter": 4, "style": "counterbore", "head_diameter": 8, "head_depth": 2, "depth": None}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z; E9 circular edge, centre (-10,0,5), radius 1.\nRequest: repeat this hole 3 times every 10 along +X",
        {"intent": "ops", "message": "", "ops": [{"op": "pattern", "of": {"op": "hole", "face": "F2", "at": {"center_of": "E9"}, "diameter": {"same_as": "E9", "what": "diameter"}, "depth": None}, "kind": "linear", "count": 3, "spacing": 10, "direction": "+X"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z; E9 circular edge, centre (10,0,5), radius 1.\nRequest: make 6 copies of this hole around the z axis",
        {"intent": "ops", "message": "", "ops": [{"op": "pattern", "of": {"op": "hole", "face": "F2", "at": {"center_of": "E9"}, "diameter": {"same_as": "E9", "what": "diameter"}, "depth": None}, "kind": "circular", "count": 6, "around": "z"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: hollow it out with 2 thick walls, open at the selected face",
        {"intent": "ops", "message": "", "ops": [{"op": "shell", "thickness": 2, "open": ["F2"]}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: engrave the word LOGO 0.5 deep on the selected face, 8 tall",
        {"intent": "ops", "message": "", "ops": [{"op": "text", "face": "F2", "text": "LOGO", "size": 8, "depth": 0.5, "mode": "engrave"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: emboss the text HELLO 1 high on the selected face, letters 6 tall",
        {"intent": "ops", "message": "", "ops": [{"op": "text", "face": "F2", "text": "HELLO", "size": 6, "depth": 1, "mode": "emboss"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: move the selected face out by 5",
        {"intent": "ops", "message": "", "ops": [{"op": "offset_face", "face": "F2", "distance": 5}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: move the selected face in by 2",
        {"intent": "ops", "message": "", "ops": [{"op": "offset_face", "face": "F2", "distance": -2}]},
    ),
    (
        "Part size 40. Selected: E7 straight edge (-20,0,5)->(20,0,5).\nRequest: add a 3 thick, 10 long support rib in this corner",
        {"intent": "ops", "message": "", "ops": [{"op": "rib", "edge": "E7", "thickness": 3, "size": 10}]},
    ),
    (
        "Part size 40. Selected: E4 straight edge (-20,0,5)->(20,0,5).\nRequest: add a 2 thick rib 8 long in this corner",
        {"intent": "ops", "message": "", "ops": [{"op": "rib", "edge": "E4", "thickness": 2, "size": 8}]},
    ),
    (
        "Part size 40. Selected: F5 planar face facing +X; F6 planar face facing -X.\nRequest: add a 3 degree draft to the selected walls pulling up",
        {"intent": "ops", "message": "", "ops": [{"op": "draft", "faces": ["F5", "F6"], "angle": 3, "pull": "+Z"}]},
    ),
    (
        "Part size 40. Selected: F2 planar face facing +Z.\nRequest: move this face up by 3",
        {"intent": "ops", "message": "", "ops": [{"op": "offset_face", "face": "F2", "distance": 3}]},
    ),
    (
        "Part size 40. Selected: none.\nFaces: F1 +Z.\nSaved versions: 4 (1 is the oldest).\nRequest: subtract version 2 from this one",
        {"intent": "ops", "message": "", "ops": [{"op": "combine", "mode": "subtract", "version": 2}]},
    ),
    (
        "Part size 40. Selected: F7 curved face centre (5,0,7); E9 circular edge, centre (-8,-8,6), radius 2.\nRequest: delete the selected items",
        {"intent": "ops", "message": "", "ops": [{"op": "remove", "targets": ["F7", "E9"]}]},
    ),
    (
        "Part size 40. Selected: F7 curved face centre (5,0,7).\nRequest: remove this boss",
        {"intent": "ops", "message": "", "ops": [{"op": "remove", "targets": ["F7"]}]},
    ),
    (
        "Part size 1.0. Selected: none.\nRequest: cut the top half off",
        {"intent": "ops", "message": "", "ops": [{"op": "cut", "plane": {"kind": "axis", "axis": "z", "at": "center"}, "keep": "-Z"}]},
    ),
    (
        "Part size 1.0. Selected: F14 curved face centre (0.2,0,0).\nRequest: what is the radius of the circle enclosed by the selected region",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "radius", "of": ["F14"]}},
    ),
    (
        "Part size 1.0. Selected: F3 planar face facing +Z; F8 planar face facing -Z.\nRequest: how far apart are these two faces?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "distance", "of": ["F3", "F8"]}},
    ),
    (
        "Part size 40. Selected: F3 planar face facing +Z; F5 planar face facing +X.\nRequest: what is the angle between these faces?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "angle", "of": ["F3", "F5"]}},
    ),
    (
        "Part size 40. Selected: F3 planar face facing +Z.\nRequest: how thick is the wall here?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "thickness", "of": ["F3"]}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: how much does it weigh in aluminum?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "mass", "of": [], "material": "aluminum"}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: how big is it overall, what are its dimensions?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "bbox", "of": []}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: is there any wall thinner than 1.2 that would fail to print",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "printability", "of": [], "threshold": 1.2}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: what is the volume?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "volume", "of": []}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: list all the holes and their sizes",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "holes", "of": []}},
    ),
    (
        "Part size 40. Selected: none.\nRequest: can this be 3D printed, any thin walls or overhangs?",
        {"intent": "measure", "message": "", "ops": [], "measure": {"what": "printability", "of": []}},
    ),
    (
        "Part size 1.0. Selected: F4 planar face facing +Z, centre (0,0,0.1).\nRequest: draw a 0.05 circle at the center of the selected face",
        {"intent": "mark", "message": "", "ops": [], "mark": {"face": "F4", "shape": "circle", "diameter": 0.05, "at": {"center": True}}},
    ),
    (
        "Part size 1.0. Selected: F2 planar face facing +Z.\nRequest: mark a 0.04 circle 0.3 from the left edge and 0.2 from the front edge",
        {"intent": "mark", "message": "", "ops": [], "mark": {"face": "F2", "shape": "circle", "diameter": 0.04, "at": {"offsets": [{"from": "left", "distance": 0.3}, {"from": "front", "distance": 0.2}]}}},
    ),
    (
        "Part size 1.8. Selected: F0 planar face facing +Z; E3 straight edge length 0.4; E0 straight edge length 1.7.\nRequest: at 0.1 from shorter edge and 0.03 from longer edge draw a red dot on face F0",
        {"intent": "mark", "message": "", "ops": [], "mark": {"face": "F0", "shape": "circle", "diameter": None, "at": {"offsets": [{"from": "shorter_edge", "distance": 0.1}, {"from": "longer_edge", "distance": 0.03}]}}},
    ),
    (
        "Part size 50. Selected: F10 planar face facing +X; F6 planar face facing -X.\nRequest: make the part 8 longer between the selected faces",
        {"intent": "ops", "message": "", "ops": [{"op": "stretch", "between": ["F6", "F10"], "distance": 8}]},
    ),
    (
        "Part size 50. Selected: F10 planar face facing +X; F6 planar face facing -X.\nRequest: bring the selected faces 3 closer together",
        {"intent": "ops", "message": "", "ops": [{"op": "stretch", "between": ["F6", "F10"], "distance": -3}]},
    ),
    (
        "Part size 35. Selected: F7 curved face, centre (0.7, 0, -2.7), area 139.\nRequest: fill in the selected hole with solid",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["F7"]}]},
    ),
    (
        "Part size 35. Selected: E35 circular edge, centre (-8,0,-3.5), radius 1.75; F11 curved face, centre (-8,0,-2.7), area 33; E47 circular edge, centre (-8,0,-4), radius 1.75.\nRequest: fill the selected hole with solid",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["E35", "F11", "E47"]}]},
    ),
    (
        "Part size 35. Selected: F2 planar face facing +Z, centre (3,0,-2), area 445.\nRequest: fill this dovetail slot so the part is solid",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["F2"]}]},
    ),
    (
        "Part size 35. Selected: F2 planar face facing +Z, centre (3,0,-2), area 445.\nRequest: make this recess flush with the top",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["F2"]}]},
    ),
    (
        "Part size 35. Selected: F2 planar face facing +Z, centre (3,0,-2), area 445.\nRequest: fill the recess so the top is flat",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["F2"]}]},
    ),
    (
        "Part size 35. Selected: E14 curved edge, length 61.\nRequest: fill in the space in the selected edge by solid material",
        {"intent": "ops", "message": "", "ops": [{"op": "fill", "targets": ["E14"]}]},
    ),
    (
        "Part size 1.0. Selected: F4 planar face facing +Z; E3 straight edge.\nRequest: draw a 0.04 circle 0.1 away from the selected edge",
        {"intent": "mark", "message": "", "ops": [], "mark": {"face": "F4", "shape": "circle", "diameter": 0.04, "at": {"offsets": [{"from": "E3", "distance": 0.1}]}}},
    ),
    (
        "Part size 1.0. Selected: F4 planar face facing +Z.\nRequest: mark a circle on the face",
        {"intent": "clarify", "message": "How wide should the circle be?", "ops": []},
    ),
    (
        "Part size 1.0. Selected: none.\nA marker is currently placed: circle diameter 0.05 on F4.\nRequest: looks good, drill it all the way through",
        {"intent": "marker", "message": "", "ops": [], "marker": {"action": "drill", "depth": None}},
    ),
    (
        "Part size 1.0. Selected: none.\nA marker is currently placed: circle diameter 0.05 on F4.\nRequest: drill it 0.02 deep",
        {"intent": "marker", "message": "", "ops": [], "marker": {"action": "drill", "depth": 0.02}},
    ),
    (
        "Part size 1.0. Selected: none.\nA marker is currently placed: circle diameter 0.05 on F4.\nRequest: remove the marker",
        {"intent": "marker", "message": "", "ops": [], "marker": {"action": "clear", "depth": None}},
    ),
    (
        "Part size 1.0. Selected: none.\nRequest: add a cylindrical boss on top",
        {"intent": "model", "message": "", "ops": []},
    ),
    (
        "Part size 1.0. Selected: none.\nRequest: drill a hole in this face",
        {"intent": "clarify", "message": "Select the face you want to drill first.", "ops": []},
    ),
]


class PlanRequest(BaseModel):
    instruction: str = Field(min_length=1, max_length=1500)
    context: str = Field(default="", max_length=6000)


@app.on_event("startup")
def load_model() -> None:
    tokenizer = AutoTokenizer.from_pretrained(BASE)
    model = AutoModelForCausalLM.from_pretrained(
        BASE, torch_dtype=torch.bfloat16, device_map="auto"
    )
    model.eval()
    state.update(tokenizer=tokenizer, model=model, ready=True)


def generate(messages: list[dict[str, str]]) -> str:
    tokenizer = state["tokenizer"]
    model = state["model"]
    ids = tokenizer.apply_chat_template(
        messages, add_generation_prompt=True, return_tensors="pt"
    ).to(model.device)
    with torch.inference_mode():
        out = model.generate(
            ids,
            do_sample=False,
            max_new_tokens=500,
            eos_token_id=[tokenizer.eos_token_id, tokenizer.convert_tokens_to_ids("<|eot_id|>")],
            pad_token_id=tokenizer.eos_token_id,
        )
    return tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True).strip()


STOP = {"the", "this", "that", "with", "and", "for", "from", "into", "these", "selected", "part", "size", "request", "face", "edge"}
PROMPT_BUDGET = 6200  # tokens for system + examples + request; the rest is for the reply and a retry


# Different words for the same idea map to one token, so a request finds examples
# that say it another way ("how big" finds "what are its dimensions").
SYNONYMS = {
    "heavy": "weigh", "weight": "weigh", "mass": "weigh",
    "big": "dimensions", "large": "dimensions", "overall": "dimensions", "size": "dimensions", "dimension": "dimensions",
    "printed": "print", "printable": "print", "printing": "print", "overhangs": "print", "overhang": "print",
    "thickness": "thick", "thinner": "thick", "thin": "thick",
    "holes": "hole", "screw": "hole", "bolt": "hole",
    "delete": "remove", "erase": "remove", "eliminate": "remove", "scrap": "remove",
    "pull": "move", "push": "move", "raise": "emboss", "engrave": "emboss", "text": "emboss", "word": "emboss",
    "pillar": "boss", "post": "boss", "stud": "boss", "hexagon": "polygon", "hexagonal": "polygon", "hex": "polygon", "pentagon": "polygon", "octagon": "polygon", "triangle": "polygon", "oval": "ellipse", "elliptical": "ellipse", "rounded": "rounded_rect", "slot": "pocket", "recess": "pocket", "pocket": "pocket",
    "copies": "pattern", "repeat": "pattern", "array": "pattern", "hollow": "shell", "gusset": "rib", "support": "rib",
}


def words(text: str) -> set[str]:
    return {SYNONYMS.get(w, w) for w in re.findall(r"[a-z]{3,}", text.lower()) if w not in STOP}


def pick_examples(instruction: str, final: dict[str, str]) -> list[dict[str, str]]:
    """The examples most like this request, as many as fit the prompt budget, in their original order.

    The full example set no longer fits the model's context, and an example about
    a different operation only distracts from the right one."""
    tokenizer = state["tokenizer"]
    wanted = words(instruction)
    ranked = sorted(
        range(len(EXAMPLES)),
        key=lambda i: (-len(wanted & words(EXAMPLES[i][0].split("Request:")[-1])), i),
    )
    chosen: list[int] = []
    for index in ranked:
        trial = sorted(chosen + [index])
        turns: list[dict[str, str]] = [{"role": "system", "content": SYSTEM}]
        for i in trial:
            turns.append({"role": "user", "content": EXAMPLES[i][0]})
            turns.append({"role": "assistant", "content": json.dumps(EXAMPLES[i][1])})
        turns.append(final)
        rendered = tokenizer.apply_chat_template(turns, add_generation_prompt=True, tokenize=False)
        if len(tokenizer(rendered, add_special_tokens=False).input_ids) > PROMPT_BUDGET:
            break
        chosen = trial
        if len(chosen) >= 28:
            break
    out: list[dict[str, str]] = []
    for i in chosen:
        out.append({"role": "user", "content": EXAMPLES[i][0]})
        out.append({"role": "assistant", "content": json.dumps(EXAMPLES[i][1])})
    return out


def extract_json(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    return json.loads(text[start : end + 1])


REF = re.compile(r"^[FEV]\d+$")
ALLOWED: set[str] = set()


def is_ref(value: Any, kind: str | None = None) -> bool:
    """A reference must exist in the request context and, if given, be a face (F) or edge (E)."""
    if isinstance(value, str):
        return bool(REF.match(value)) and value in ALLOWED and (kind is None or value[0] == kind)
    return (
        kind != "E"
        and isinstance(value, dict)
        and re.match(r"^[+-][XYZ]$", str(value.get("facing", ""))) is not None
    )


def only_selected(refs: list, what: str) -> None:
    """When the user selected things, an operation may only act on those, not on other faces."""
    found = re.search(r"Selected: ([^\n]*)", CONTEXT["text"])
    chosen = set(re.findall(r"\b[FEV]\d+\b", found.group(1))) if found else set()
    if chosen and any(isinstance(r, str) and r not in chosen for r in refs):
        raise ValueError(f"{what} may only use the selected items {sorted(chosen)}")


def is_quantity(value: Any, name: str) -> bool:
    """A size: a positive number from the request, or the size of an existing round feature."""
    if isinstance(value, dict):
        return is_ref(value.get("same_as")) and value.get("what") in ("diameter", "radius") and len(value) == 2
    if not number(value) or value <= 0:
        return False
    from_request(value, name)
    return True


def is_point(through: Any) -> bool:
    """A POINT: a corner, edge, face, a position along an edge, midpoint between two references, or the part centre."""
    if isinstance(through, dict) and "along" in through:
        if not is_ref(through.get("along"), "E"):
            return False
        if "fraction" in through:
            fraction = through["fraction"]
            if not number(fraction) or not 0 <= fraction <= 1:
                return False
            from_request(fraction, "fraction")
            return True
        distance, origin = through.get("distance"), through.get("from")
        if not number(distance) or distance < 0 or not (origin in ("start", "end") or is_ref(origin, "V")):
            return False
        from_request(distance, "distance")
        return True
    return isinstance(through, dict) and (
        is_ref(through.get("vertex"), "V")
        or is_ref(through.get("center_of"))
        or is_ref(through.get("edge"), "E")
        or is_ref(through.get("face"), "F")
        or (isinstance(through.get("midway"), list) and len(through["midway"]) == 2 and all(is_ref(r) for r in through["midway"]))
        or through.get("center") is True
    )


SIDE_WORDS = {
    "triangle": 3, "triangular": 3, "pentagon": 5, "pentagonal": 5, "hexagon": 6, "hexagonal": 6,
    "heptagon": 7, "octagon": 8, "octagonal": 8, "nonagon": 9, "decagon": 10, "dodecagon": 12,
}


def check_sides(sides: Any) -> None:
    """A side/point count must be a whole number the request names (a shape word or a figure)."""
    if not number(sides) or int(sides) != sides or not 3 <= sides <= 64:
        raise ValueError("sides must be a whole number from 3 to 64")
    text = SOURCE["text"].lower()
    named = {n for word, n in SIDE_WORDS.items() if re.search(rf"\b{word}\b", text)}
    named |= {int(g) for g in GIVEN if float(g).is_integer()}
    if sides not in named:
        raise ValueError(f"sides {int(sides)} is not named in the request; use one of {sorted(named)}")


def check_profile(profile: Any) -> None:
    shape = profile.get("shape") if isinstance(profile, dict) else None
    if shape == "circle":
        keys = ("diameter",)
    elif shape in ("rect", "slot", "polygon", "star"):
        keys = ("width", "height") if shape == "slot" else ("width",)
    elif shape in ("ellipse", "rounded_rect"):
        keys = ("width", "height") + (("radius",) if shape == "rounded_rect" else ())
    else:
        raise ValueError("profile shape must be rect, circle, slot, polygon, ellipse, rounded_rect or star")
    if shape in ("polygon", "star"):
        check_sides(profile.get("sides"))
    for key in keys:
        if not number(profile.get(key)) or profile[key] <= 0:
            raise ValueError(f"profile needs a positive {key}")
        from_request(profile[key], key)
    if shape == "rect" and profile.get("height") is not None:
        if not number(profile["height"]) or profile["height"] <= 0:
            raise ValueError("invalid profile height")
        from_request(profile["height"], "height")


def check_feature(op: dict) -> None:
    """A hole, pocket, boss or text on a planar face, optionally placed at a POINT."""
    kind = op.get("op")
    if not is_ref(op.get("face"), "F"):
        raise ValueError(f"{kind} needs a face id from the context")
    if op.get("at") is not None and not is_point(op["at"]):
        raise ValueError(f"{kind} position must be a POINT")
    rotation = op.get("rotation")
    if rotation is not None:
        if not number(rotation) or not -360 <= rotation <= 360:
            raise ValueError("invalid rotation")
        from_request(rotation, "rotation")
    if kind == "hole":
        metric = op.get("metric")
        if metric is not None:
            if not isinstance(metric, str) or METRIC.match(metric) is None or metric.lower() not in SOURCE["text"].lower():
                raise ValueError("metric must be a screw size such as M3 that the request names")
            if op.get("fit") not in (None, "clearance", "tap"):
                raise ValueError("fit must be clearance or tap")
            # Standard screw sizes come with fixed head sizes; never take invented ones.
            op.pop("diameter", None)
            op.pop("head_diameter", None)
            op.pop("head_depth", None)
        elif not is_quantity(op.get("diameter"), "diameter"):
            raise ValueError("invalid hole: give a diameter or a metric size")
        depth = op.get("depth")
        if depth is not None:
            if not number(depth) or depth <= 0:
                raise ValueError("invalid hole depth")
            from_request(depth, "depth")
        style = op.get("style")
        if style not in (None, "simple", "counterbore", "countersink"):
            raise ValueError("style must be counterbore or countersink")
        # The style is whatever the request says; the model sometimes swaps the two.
        said = SOURCE["text"].lower()
        if "counterbor" in said:
            style = op["style"] = "counterbore"
        elif "countersink" in said or "countersunk" in said:
            style = op["style"] = "countersink"
        elif style in ("counterbore", "countersink"):
            style = op["style"] = None
        for key in ("head_diameter", "head_depth", "angle"):
            if op.get(key) is not None:
                if not number(op[key]) or op[key] <= 0:
                    raise ValueError(f"invalid {key}")
                from_request(op[key], key)
        if style in ("counterbore", "countersink") and metric is None and op.get("head_diameter") is None:
            raise ValueError(f"a {style} needs head_diameter (or a metric size)")
        if style == "counterbore" and metric is None and op.get("head_depth") is None:
            raise ValueError("a counterbore needs head_depth (or a metric size)")
    elif kind in ("pocket", "boss"):
        check_profile(op.get("profile"))
        key = "depth" if kind == "pocket" else "height"
        value = op.get(key)
        if value is None and kind == "pocket":
            pass
        elif not number(value) or value <= 0:
            raise ValueError(f"{kind} needs a positive {key}")
        else:
            from_request(value, key)
    else:  # text
        text = op.get("text")
        if not isinstance(text, str) or not text.strip() or text.lower() not in SOURCE["text"].lower():
            raise ValueError("the text to add must be quoted from the request")
        if op.get("mode") not in ("emboss", "engrave") or not number(op.get("depth")) or op["depth"] <= 0:
            raise ValueError("text needs mode emboss or engrave and a positive depth")
        from_request(op["depth"], "depth")
        if op.get("size") is not None:
            if not number(op["size"]) or op["size"] <= 0:
                raise ValueError("invalid text size")
            from_request(op["size"], "size")


def check_plane(plane: Any) -> None:
    if not isinstance(plane, dict):
        raise ValueError("plane must be an object")
    kind = plane.get("kind")
    if kind == "through_points":
        points = plane.get("points")
        ok = isinstance(points, list) and len(points) == 3 and all(is_point(p) for p in points)
    elif kind == "edge_and_point":
        ok = is_ref(plane.get("edge"), "E") and is_point(plane.get("point"))
    elif kind == "edge_at_angle":
        angle = plane.get("angle")
        ok = is_ref(plane.get("edge"), "E") and is_ref(plane.get("face"), "F") and number(angle) and -180 <= angle <= 180
        if ok:
            from_request(angle, "angle")
    elif kind == "tangent_to_face":
        ok = is_ref(plane.get("face"), "F") and re.match(r"^[+-][XYZ]$", str(plane.get("side", ""))) is not None
    elif kind == "through_axis":
        ok = is_ref(plane.get("of")) and re.match(r"^[+-][XYZ]$", str(plane.get("direction", ""))) is not None
    elif kind == "middle_of":
        refs = plane.get("of")
        ok = isinstance(refs, list) and 1 <= len(refs) <= 6 and all(is_ref(r) for r in refs) and plane.get("axis") in ("x", "y", "z")
    elif kind == "rotated":
        angle, about = plane.get("angle"), plane.get("about")
        check_plane(plane.get("base"))
        ok = number(angle) and -180 <= angle <= 180 and (about in ("x", "y", "z") or is_ref(about, "E"))
        if ok:
            from_request(angle, "angle")
    elif kind == "face":
        ok = is_ref(plane.get("face"), "F")
    elif kind == "through_edges":
        edges = plane.get("edges")
        ok = isinstance(edges, list) and len(edges) == 2 and all(is_ref(e, "E") for e in edges)
    elif kind == "parallel_to_face":
        ok = is_ref(plane.get("face"), "F") and is_point(plane.get("through"))
    elif kind == "offset":
        check_plane(plane.get("base"))
        direction = plane.get("direction")
        distance = plane.get("distance")
        ok = (
            isinstance(direction, str)
            and re.match(r"^[+-][XYZ]$", direction) is not None
            and number(distance)
            and distance > 0
        )
        if ok:
            from_request(distance, "distance")
    elif kind == "across_edge":
        through = plane.get("through")
        ok = is_ref(plane.get("edge"), "E") and (through is None or is_point(through))
    elif kind == "axis":
        at = plane.get("at", "center")
        ok = plane.get("axis") in ("x", "y", "z") and (at == "center" or isinstance(at, (int, float)))
    else:
        ok = False
    if not ok:
        raise ValueError(f"invalid plane {plane!r}; use only ids that appear in the context, faces as F and edges as E")


def number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


NUMBER = re.compile(r"(?<![\w.])-?\d+(?:\.\d+)?")
WORD_NUMBERS = {
    "half": 0.5, "double": 2.0, "twice": 2.0, "triple": 3.0, "thrice": 3.0, "pair": 2.0,
    "two": 2.0, "three": 3.0, "four": 4.0, "five": 5.0, "six": 6.0, "seven": 7.0,
    "eight": 8.0, "nine": 9.0, "ten": 10.0, "eleven": 11.0, "twelve": 12.0,
}
METRIC = re.compile(r"^M(?:2|2\.5|3|4|5|6|8|10|12)$")
CONTEXT = {"text": ""}
SOURCE = {"text": ""}  # the current request, for checks on quoted text and screw sizes
GIVEN: list[float] = []
WRITTEN: list[float] = []
REQUIRED: list[float] = []
COUNT_WORDS = r"(?:parts?|halves|pieces?|equal|sections?|times|x|sides?|faces?|edges?|holes?)"


def given_numbers(text: str) -> list[float]:
    values = [float(m) for m in NUMBER.findall(text)]
    values += [v / 100 for v in values]  # "50%" -> 0.5
    values += [v for word, v in WORD_NUMBERS.items() if re.search(rf"\b{word}\b", text, re.I)]
    return values


def from_request(value: float, name: str) -> None:
    """Numbers must be copied from the request, never invented by the model."""
    if not GIVEN:
        return
    if not any(abs(abs(value) - abs(g)) <= 1e-9 * max(1.0, abs(g)) for g in GIVEN):
        raise ValueError(f"{name} {value} is not a number from the request; use one of {WRITTEN}")


def collect_numbers(node: Any, out: list[float]) -> None:
    if isinstance(node, dict):
        for value in node.values():
            collect_numbers(value, out)
    elif isinstance(node, list):
        for value in node:
            collect_numbers(value, out)
    elif number(node):
        out.append(abs(float(node)))


def ensure_all_used(node: Any) -> None:
    leaves: list[float] = []
    collect_numbers(node, leaves)
    unused = [
        n
        for n in REQUIRED
        if not any(abs(abs(n) - leaf) <= 1e-9 * max(1.0, abs(n)) or abs(abs(n) / 100 - leaf) <= 1e-9 for leaf in leaves)
    ]
    if unused:
        raise ValueError(
            f"the request gives {unused} but nothing uses it; include every measurement in the answer"
        )


SIDES = ("left", "right", "front", "back", "top", "bottom", "shorter_edge", "longer_edge")


def as_point(value: Any) -> Any:
    """A bare reference where a POINT is expected means that thing's own point."""
    if isinstance(value, str) and REF.match(value):
        return {"vertex": value} if value[0] == "V" else {"center_of": value} if value[0] == "E" else {"face": value}
    return value


def is_round_edge(ref: Any) -> bool:
    return isinstance(ref, str) and re.search(rf"\b{ref}\b[:,]? (?:circular|a circle|round)", CONTEXT["text"]) is not None


def tidy_points(node: Any) -> None:
    """Accept the small slips the model makes when writing POINTs, in place."""
    if isinstance(node, dict):
        for key in ("at", "through", "point"):
            if key in node:
                node[key] = as_point(node[key])
                spot = node[key]
                # "A position along a circular edge" can only mean the edge's centre.
                if isinstance(spot, dict) and "along" in spot and is_round_edge(spot["along"]):
                    node[key] = {"center_of": spot["along"]}
        if isinstance(node.get("points"), list):
            node["points"] = [as_point(p) for p in node["points"]]
        for value in node.values():
            tidy_points(value)
    elif isinstance(node, list):
        for value in node:
            tidy_points(value)


def validate(plan: dict[str, Any]) -> dict[str, Any]:
    if "intent" not in plan:
        # A reply that is just the operations, or one operation, still means "ops".
        if isinstance(plan.get("ops"), list) and plan["ops"]:
            plan["intent"] = "ops"
        elif "op" in plan:
            plan = {"intent": "ops", "message": "", "ops": [plan]}
    tidy_points(plan)
    intent = plan.get("intent")
    if intent not in ("ops", "measure", "mark", "marker", "model", "clarify"):
        raise ValueError("intent must be ops, measure, mark, marker, model or clarify")
    ops = plan.get("ops") or []
    if intent == "mark":
        mark = plan.get("mark")
        if not isinstance(mark, dict) or not is_ref(mark.get("face"), "F") or mark.get("shape") != "circle":
            raise ValueError("mark needs a face id from the context and shape 'circle'")
        diameter = mark.get("diameter")
        if diameter is not None:
            if not number(diameter) or diameter <= 0:
                raise ValueError("mark diameter must be a positive number, or null when no size is given")
            from_request(diameter, "diameter")
        at = mark.get("at")
        if isinstance(at, dict) and at.get("center") is True:
            clean_at: dict[str, Any] = {"center": True}
        elif isinstance(at, dict) and isinstance(at.get("offsets"), list) and 1 <= len(at["offsets"]) <= 2:
            offsets = []
            for offset in at["offsets"]:
                source = offset.get("from") if isinstance(offset, dict) else None
                distance = offset.get("distance") if isinstance(offset, dict) else None
                if not (source in SIDES or is_ref(source, "E")) or not number(distance) or distance < 0:
                    raise ValueError("each offset needs 'from' (a side or an edge id from the context) and a distance")
                if distance:
                    from_request(distance, "distance")
                offsets.append({"from": source, "distance": distance})
            clean_at = {"offsets": offsets}
        else:
            raise ValueError("mark.at must be {center: true} or {offsets: [...]}")
        clean = {"face": mark["face"], "shape": "circle", "diameter": diameter, "at": clean_at}
        ensure_all_used(clean)
        return {"intent": "mark", "message": "", "ops": [], "mark": clean}
    if intent == "marker":
        marker = plan.get("marker")
        if not isinstance(marker, dict) or marker.get("action") not in ("drill", "clear"):
            raise ValueError("marker needs action 'drill' or 'clear'")
        depth = marker.get("depth")
        if depth is not None:
            if not number(depth) or depth <= 0:
                raise ValueError("invalid depth")
            from_request(depth, "depth")
        clean_marker = {"action": marker["action"], "depth": depth}
        ensure_all_used(clean_marker)
        return {"intent": "marker", "message": "", "ops": [], "marker": clean_marker}
    if intent == "measure":
        measure = plan.get("measure")
        whole = ("volume", "surface_area", "bbox", "mass", "holes", "printability")
        what = measure.get("what") if isinstance(measure, dict) else None
        refs = measure.get("of") if isinstance(measure, dict) else None
        if (
            what not in ("radius", "diameter", "length", "area", "distance", "center", "angle", "thickness", *whole)
            or not isinstance(refs, list)
            or not all(is_ref(r) for r in refs)
            or (not refs and what not in whole)
        ):
            raise ValueError("measure needs 'what' and 'of' with ids that appear in the context")
        # "How big / what size / dimensions" is the bounding box unless volume is asked for by name.
        said = SOURCE["text"].lower()
        if what in ("volume", "surface_area") and not re.search(r"volume|area|cm3|cubic|surface", said) and re.search(r"\b(big|large|dimensions?|size|overall|long|wide|tall)\b", said):
            what = "bbox"
        clean: dict[str, Any] = {"what": what, "of": refs}
        material = measure.get("material")
        if what == "mass":
            if material is not None and (not isinstance(material, str) or material.lower() not in SOURCE["text"].lower()):
                raise ValueError("material must be a word from the request, or null")
            clean["material"] = material
        threshold = measure.get("threshold")
        if what == "printability" and threshold is not None:
            if not number(threshold) or threshold <= 0:
                raise ValueError("invalid threshold")
            from_request(threshold, "threshold")
            clean["threshold"] = threshold
        return {"intent": "measure", "message": "", "ops": [], "measure": clean}
    if intent != "ops":
        return {"intent": intent, "message": str(plan.get("message") or ""), "ops": []}
    if not ops or len(ops) > 8:
        raise ValueError("ops must have 1 to 8 entries")
    for op in ops:
        kind = op.get("op")
        if kind == "cut":
            check_plane(op.get("plane"))
            keep = op.get("keep", "split")
            if not (keep == "split" or re.match(r"^[+-][XYZ]$", str(keep)) or is_ref(keep, "F")):
                raise ValueError(f"invalid keep {keep!r}")
            op["keep"] = keep
        elif kind == "mirror":
            check_plane(op.get("plane"))
        elif kind in ("hole", "pocket", "boss", "text"):
            check_feature(op)
        elif kind == "shell":
            opened = op.get("open")
            if not number(op.get("thickness")) or op["thickness"] <= 0 or not isinstance(opened, list) or not opened or not all(is_ref(r, "F") for r in opened):
                raise ValueError("invalid shell: needs a wall thickness and the face ids to leave open")
            from_request(op["thickness"], "thickness")
            if len(opened) > 6:
                raise ValueError("a shell can leave at most 6 faces open")
            only_selected(opened, "the faces left open")
        elif kind == "offset_face":
            if not is_ref(op.get("face"), "F") or not number(op.get("distance")) or op["distance"] == 0:
                raise ValueError("invalid offset_face: needs a face id and a nonzero signed distance")
            from_request(op["distance"], "distance")
        elif kind == "remove":
            targets = op.get("targets")
            if not isinstance(targets, list) or not targets or not all(is_ref(r) for r in targets):
                raise ValueError("invalid remove: targets must be face or edge ids from the context")
        elif kind == "rib":
            if not is_ref(op.get("edge"), "E") or not (op.get("at") is None or is_point(op["at"])):
                raise ValueError("invalid rib: needs the corner edge id")
            for key in ("thickness", "size"):
                if not number(op.get(key)) or op[key] <= 0:
                    raise ValueError(f"invalid rib {key}")
                from_request(op[key], key)
        elif kind == "draft":
            faces = op.get("faces")
            if (
                not isinstance(faces, list) or not faces or not all(is_ref(r, "F") for r in faces)
                or not number(op.get("angle")) or not 0 < abs(op["angle"]) <= 45
                or re.match(r"^[+-][XYZ]$", str(op.get("pull", ""))) is None
            ):
                raise ValueError("invalid draft: needs face ids, an angle up to 45 degrees and a pull direction like +Z")
            from_request(op["angle"], "angle")
            only_selected(faces, "a draft")
        elif kind == "combine":
            found = re.search(r"Saved versions: (\d+)", CONTEXT["text"])
            version = op.get("version")
            if (
                op.get("mode") not in ("union", "subtract", "intersect")
                or not isinstance(version, int) or isinstance(version, bool)
                or not found or not 1 <= version < int(found.group(1))
            ):
                raise ValueError("combine needs a mode and the number of an EARLIER saved version listed in the context")
            from_request(float(version), "version")
        elif kind == "pattern":
            inner = op.get("of")
            if not isinstance(inner, dict) or inner.get("op") not in ("hole", "pocket", "boss", "text"):
                raise ValueError("a pattern repeats a hole, pocket, boss or text")
            check_feature(inner)
            count = op.get("count")
            if not isinstance(count, int) or isinstance(count, bool) or not 2 <= count <= 64:
                raise ValueError("invalid pattern count")
            from_request(float(count), "count")
            if op.get("kind") == "linear":
                direction = op.get("direction")
                if not number(op.get("spacing")) or op["spacing"] <= 0 or not (
                    re.match(r"^[+-][XYZ]$", str(direction)) is not None
                    or (isinstance(direction, dict) and is_ref(direction.get("edge"), "E"))
                ):
                    raise ValueError("a linear pattern needs a spacing and a direction like +X or {\"edge\": E3}")
                from_request(op["spacing"], "spacing")
            elif op.get("kind") == "circular":
                around = op.get("around")
                if not (around in ("x", "y", "z") or is_ref(around)):
                    raise ValueError("a circular pattern needs 'around': x, y, z or a round feature id")
                angle = op.get("angle")
                if angle is not None:
                    if not number(angle) or not 0 < abs(angle) <= 360:
                        raise ValueError("invalid pattern angle")
                    from_request(angle, "angle")
            else:
                raise ValueError("pattern kind must be linear or circular")
        elif kind in ("fillet", "chamfer"):
            key = "radius" if kind == "fillet" else "distance"
            edges = op.get("edges")
            if not isinstance(edges, list) or not edges or not all(is_ref(e, "E") for e in edges) or not is_quantity(op.get(key), key):
                raise ValueError(f"invalid {kind}")
        elif kind == "fill":
            targets = op.get("targets")
            if not isinstance(targets, list) or not targets or not all(is_ref(r) for r in targets):
                raise ValueError("invalid fill: targets must be face or edge ids from the context")
        elif kind == "stretch":
            between = op.get("between")
            if (
                not isinstance(between, list)
                or len(between) != 2
                or not all(is_ref(r, "F") for r in between)
                or not number(op.get("distance"))
                or op["distance"] == 0
            ):
                raise ValueError("invalid stretch: needs two face ids and a nonzero distance")
            from_request(op["distance"], "distance")
        elif kind == "scale":
            if not number(op.get("factor")) or op["factor"] <= 0:
                raise ValueError("invalid scale")
            from_request(op["factor"], "factor")
        elif kind == "translate":
            vector = op.get("vector")
            if not isinstance(vector, list) or len(vector) != 3 or not all(number(v) for v in vector):
                raise ValueError("invalid translate")
            for component in vector:
                if component != 0:
                    from_request(component, "vector component")
        else:
            raise ValueError(f"unknown op {kind!r}")
    leaves: list[float] = []

    def collect(node: Any) -> None:
        if isinstance(node, dict):
            for value in node.values():
                collect(value)
        elif isinstance(node, list):
            for value in node:
                collect(value)
        elif number(node):
            leaves.append(abs(float(node)))

    collect(ops)
    unused = [
        n
        for n in REQUIRED
        if not any(abs(abs(n) - leaf) <= 1e-9 * max(1.0, abs(n)) or abs(abs(n) / 100 - leaf) <= 1e-9 for leaf in leaves)
    ]
    if unused:
        raise ValueError(
            f"the request gives {unused} but no operation uses it; include every measurement, for example as an offset distance"
        )
    return {"intent": "ops", "message": "", "ops": ops}


@app.get("/health")
def health():
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    return {"status": "ready", "model": "meta-llama/Meta-Llama-3-8B-Instruct", "format": "cad-plan"}


@app.post("/plan")
def plan(request: PlanRequest):
    if not state["ready"]:
        raise HTTPException(status_code=503, detail="loading")
    instruction = re.sub(r"\b(pull|push)\b", "move", request.instruction, flags=re.I) if re.search(r"\bface\b", request.instruction, re.I) else request.instruction
    request = request.model_copy(update={"instruction": instruction})
    final = {"role": "user", "content": f"{request.context}\nRequest: {request.instruction}"}
    messages = [{"role": "system", "content": SYSTEM}, *pick_examples(request.instruction, final)]
    messages.append(final)
    error = "unknown"
    with lock:
        ALLOWED.clear()
        ALLOWED.update(re.findall(r"\b[FEV]\d+\b", request.context))
        SOURCE["text"] = request.instruction
        CONTEXT["text"] = request.context
        GIVEN.clear()
        GIVEN.extend(given_numbers(request.instruction))
        WRITTEN.clear()
        WRITTEN.extend(float(m) for m in NUMBER.findall(request.instruction))
        REQUIRED.clear()
        for match in NUMBER.finditer(request.instruction):
            tail = request.instruction[match.end():match.end() + 12]
            if re.match(rf"\s*{COUNT_WORDS}\b", tail, re.I):
                continue  # a count such as "2 halves" or "1.5 times", not a length
            REQUIRED.append(float(match.group()))
        for _ in range(2):
            reply = generate(messages)
            try:
                return {"model": "meta-llama/Meta-Llama-3-8B-Instruct", **validate(extract_json(reply))}
            except (ValueError, json.JSONDecodeError, AttributeError, TypeError) as exc:
                error = str(exc)
                print(f"PLAN-REJECTED {error} :: {reply[:600]}", flush=True)
                messages.append({"role": "assistant", "content": reply})
                messages.append({"role": "user", "content": f"Invalid: {error}. Reply again with corrected JSON only. If the needed faces or edges are not in the context, use intent clarify."})
    raise HTTPException(status_code=422, detail=f"planner could not produce a valid plan: {error}")
