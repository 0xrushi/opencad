"""Fill-cavity regression tests. Run inside the cad-render image: see run.sh.

Set CADAM_TEST_STEP to a STEP file (e.g. the wall mount) to also run the
real-part checks; the synthetic checks always run.
"""
import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cadquery as cq  # noqa: E402
import OCP.BRepAlgoAPI as BRepAlgoAPI  # noqa: E402

import worker  # noqa: E402


def volume(shape):
    return sum(solid.Volume() for solid in worker.solids_of(shape))


def pocket_box():
    return cq.Workplane().box(40, 30, 10).faces(">Z").workplane().rect(20, 10).cutBlind(-4)


def blind_hole_box():
    return cq.Workplane().box(40, 30, 10).faces(">Z").workplane().circle(4).cutBlind(-6)


class BrokenDefeaturing(BRepAlgoAPI.BRepAlgoAPI_Defeaturing):
    def IsDone(self):
        return False


class SyntheticFill(unittest.TestCase):
    def test_pocket_becomes_a_solid_block(self):
        filled = worker.op_fill(pocket_box(), {"points": [[0, 0, 1]]})
        self.assertAlmostEqual(volume(filled), 12000.0, places=1)

    def test_blind_hole_becomes_a_solid_block(self):
        filled = worker.op_fill(blind_hole_box(), {"points": [[0, 0, -1]]})
        self.assertAlmostEqual(volume(filled), 12000.0, places=1)

    def test_outer_face_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no cavity"):
            worker.op_fill(pocket_box(), {"points": [[15, 0, 5]]})

    def test_split_parts_are_refused(self):
        two = cq.Workplane().add(
            [cq.Solid.makeBox(5, 5, 5), cq.Solid.makeBox(5, 5, 5).translate(cq.Vector(20, 0, 0))]
        )
        with self.assertRaisesRegex(ValueError, "single solid"):
            worker.op_fill(two, {"points": [[1, 1, 1]]})


class FillPreview(unittest.TestCase):
    def test_preview_names_the_cavity_faces_without_changing_the_part(self):
        shape = pocket_box()
        before = volume(shape)
        solid, faces, chosen = worker.op_fill(shape, {"points": [[0, 0, 1]]}, preview=True)
        self.assertEqual(len(chosen), 5)  # floor and four walls
        self.assertAlmostEqual(volume(shape), before)

    def test_preview_refuses_what_fill_refuses(self):
        with self.assertRaisesRegex(ValueError, "no cavity"):
            worker.op_fill(pocket_box(), {"points": [[15, 0, 5]]}, preview=True)


class CappingFallback(unittest.TestCase):
    """With defeaturing broken, capping the opening must still fill flat-rimmed cavities."""

    def setUp(self):
        self.original = BRepAlgoAPI.BRepAlgoAPI_Defeaturing
        BRepAlgoAPI.BRepAlgoAPI_Defeaturing = BrokenDefeaturing

    def tearDown(self):
        BRepAlgoAPI.BRepAlgoAPI_Defeaturing = self.original

    def test_pocket(self):
        filled = worker.op_fill(pocket_box(), {"points": [[0, 0, 1]]})
        self.assertAlmostEqual(volume(filled), 12000.0, places=1)

    def test_blind_hole(self):
        filled = worker.op_fill(blind_hole_box(), {"points": [[0, 0, -1]]})
        self.assertAlmostEqual(volume(filled), 12000.0, places=1)

    def test_failure_is_reported_not_silent(self):
        # A fill that cannot be completed must raise, never return the part unchanged.
        shape = pocket_box()
        before = volume(shape)
        try:
            after = volume(worker.op_fill(shape, {"points": [[0, 0, 1]]}))
        except ValueError as error:
            self.assertIn("could not be filled completely", str(error))
        else:
            self.assertGreater(after, before)


STEP = os.environ.get("CADAM_TEST_STEP")


@unittest.skipUnless(STEP and Path(STEP).exists(), "set CADAM_TEST_STEP to the wall mount STEP")
class WallMount(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.shape = cq.importers.importStep(STEP)
        cls.faces = worker.solids_of(cls.shape)[0].Faces()

    def surface_point(self, face):
        u0, u1, v0, v1 = face._uvBounds()
        return list(face.normalAt((u0 + u1) / 2, (v0 + v1) / 2)[1].toTuple())

    def test_countersunk_hole_from_its_cone(self):
        cone = next(f for f in self.faces if f.geomType() == "CONE" and self.fills(f))
        self.assertAlmostEqual(
            volume(worker.op_fill(self.shape, {"points": [self.surface_point(cone)]})),
            2872.8,
            delta=0.5,
        )

    def test_recess_from_its_floor(self):
        floor = next(
            f for f in self.faces
            if f.geomType() == "PLANE" and abs(f.Center().z + 2) < 0.05 and f.Area() > 10
        )
        c = floor.Center()
        self.assertGreater(
            volume(worker.op_fill(self.shape, {"points": [[c.x, c.y, c.z]]})), 3700
        )

    def test_top_face_is_refused(self):
        with self.assertRaisesRegex(ValueError, "no cavity"):
            worker.op_fill(self.shape, {"points": [[0, 0, 4.0]]})

    def fills(self, face):
        try:
            worker.op_fill(self.shape, {"points": [self.surface_point(face)]})
            return True
        except ValueError:
            return False


if __name__ == "__main__":
    unittest.main()
