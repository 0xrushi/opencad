"""Feature-operation tests (pocket, boss, hole styles, pattern, shell, ...). See run.sh."""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cadquery as cq  # noqa: E402

import worker  # noqa: E402

BLOCK = 40 * 30 * 10
UP = [0, 0, 1]


def block():
    return cq.Workplane().box(40, 30, 10)


def volume(shape):
    return sum(solid.Volume() for solid in worker.solids_of(shape))


def apply(shape, *ops):
    return worker.apply_ops(shape, list(ops))


class Pockets(unittest.TestCase):
    def test_rectangle_to_a_depth(self):
        out = apply(block(), {"type": "pocket", "origin": [0, 0, 5], "normal": UP, "profile": "rect", "width": 10, "height": 6, "depth": 3})
        self.assertAlmostEqual(volume(out), BLOCK - 10 * 6 * 3, places=1)

    def test_round_through(self):
        out = apply(block(), {"type": "pocket", "origin": [0, 0, 5], "normal": UP, "profile": "circle", "diameter": 4})
        self.assertAlmostEqual(volume(out), BLOCK - math.pi * 4 * 10, places=1)

    def test_slot(self):
        out = apply(block(), {"type": "pocket", "origin": [0, 0, 5], "normal": UP, "profile": "slot", "width": 10, "height": 4, "depth": 2})
        self.assertAlmostEqual(volume(out), BLOCK - ((10 - 4) * 4 + math.pi * 4) * 2, places=1)

    def test_rotation_turns_the_outline(self):
        out = apply(block(), {"type": "pocket", "origin": [0, 0, 5], "normal": UP, "profile": "rect", "width": 30, "height": 4, "depth": 2, "rotation": 90})
        # A 30-long rectangle turned to run along Y still fits the 30-deep block.
        self.assertAlmostEqual(volume(out), BLOCK - 30 * 4 * 2, places=1)

    def test_off_the_part_is_refused(self):
        with self.assertRaisesRegex(ValueError, "does not touch"):
            apply(block(), {"type": "pocket", "origin": [0, 0, 50], "normal": UP, "profile": "circle", "diameter": 4})


class Bosses(unittest.TestCase):
    def test_round_boss(self):
        out = apply(block(), {"type": "boss", "origin": [0, 0, 5], "normal": UP, "profile": "circle", "diameter": 6, "depth": 4})
        self.assertAlmostEqual(volume(out), BLOCK + math.pi * 9 * 4, places=1)

    def test_floating_boss_is_refused(self):
        with self.assertRaises(ValueError):
            apply(block(), {"type": "boss", "origin": [0, 0, 50], "normal": UP, "profile": "circle", "diameter": 6, "depth": 4})


class HoleStyles(unittest.TestCase):
    def test_counterbore(self):
        out = apply(block(), {"type": "hole", "origin": [0, 0, 5], "normal": UP, "diameter": 4, "style": "counterbore", "head_diameter": 8, "head_depth": 2})
        self.assertAlmostEqual(volume(out), BLOCK - (math.pi * 4 * 10 + math.pi * (16 - 4) * 2), places=0)

    def test_countersink(self):
        out = apply(block(), {"type": "hole", "origin": [0, 0, 5], "normal": UP, "diameter": 4, "style": "countersink", "head_diameter": 8, "angle": 90})
        cone = math.pi * 2 / 3 * (16 + 8 + 4)
        self.assertAlmostEqual(volume(out), BLOCK - (math.pi * 4 * 8 + cone), places=0)

    def test_head_must_be_larger(self):
        with self.assertRaisesRegex(ValueError, "larger"):
            apply(block(), {"type": "hole", "origin": [0, 0, 5], "normal": UP, "diameter": 4, "style": "countersink", "head_diameter": 3})


class Patterns(unittest.TestCase):
    hole = {"type": "hole", "origin": [-10, 0, 5], "normal": UP, "diameter": 2}

    def test_linear(self):
        out = apply(block(), {"type": "pattern", "of": self.hole, "kind": "linear", "count": 3, "vector": [1, 0, 0], "distance": 10})
        self.assertAlmostEqual(volume(out), BLOCK - 3 * math.pi * 10, places=1)

    def test_circular(self):
        hole = dict(self.hole, origin=[10, 0, 5])
        out = apply(block(), {"type": "pattern", "of": hole, "kind": "circular", "count": 4, "origin": [0, 0, 0], "normal": UP})
        self.assertAlmostEqual(volume(out), BLOCK - 4 * math.pi * 10, places=1)

    def test_the_original_feature_may_already_exist(self):
        once = apply(block(), self.hole)
        out = apply(once, {"type": "pattern", "of": self.hole, "kind": "linear", "count": 3, "vector": [1, 0, 0], "distance": 10})
        self.assertAlmostEqual(volume(out), BLOCK - 3 * math.pi * 10, places=1)

    def test_a_copy_that_misses_the_part_is_refused(self):
        with self.assertRaises(ValueError):
            apply(block(), {"type": "pattern", "of": self.hole, "kind": "linear", "count": 3, "vector": [1, 0, 0], "distance": 100})

    def test_only_features_repeat(self):
        with self.assertRaisesRegex(ValueError, "only a hole"):
            apply(block(), {"type": "pattern", "of": {"type": "scale", "factor": 2}, "kind": "linear", "count": 2, "vector": [1, 0, 0], "distance": 5})


class Shells(unittest.TestCase):
    def test_open_top(self):
        out = apply(block(), {"type": "shell", "thickness": 2, "points": [[0, 0, 5]]})
        self.assertAlmostEqual(volume(out), BLOCK - 36 * 26 * 8, places=0)

    def test_l_bracket_opened_underneath_but_not_at_an_inner_floor(self):
        bracket = block().union(cq.Workplane().box(4, 30, 16).translate((-18, 0, 8)).translate((0, 0, 0)))
        shelled = apply(bracket, {"type": "shell", "thickness": 1.5, "points": [[0, 0, -5]]})
        self.assertLess(volume(shelled), volume(bracket))
        with self.assertRaisesRegex(ValueError, "outer face"):
            apply(bracket, {"type": "shell", "thickness": 1.5, "points": [[10, 0, 5]]})

    def test_too_thick_is_refused(self):
        with self.assertRaises(ValueError):
            apply(block(), {"type": "shell", "thickness": 20, "points": [[0, 0, 5]]})


class OffsetFace(unittest.TestCase):
    def test_out_and_in(self):
        out = apply(block(), {"type": "offset_face", "points": [[0, 0, 5]], "distance": 3})
        self.assertAlmostEqual(volume(out), BLOCK + 40 * 30 * 3, places=1)
        back = apply(block(), {"type": "offset_face", "points": [[0, 0, 5]], "distance": -2})
        self.assertAlmostEqual(volume(back), BLOCK - 40 * 30 * 2, places=1)

    def test_curved_face_is_refused(self):
        cylinder = cq.Workplane().circle(5).extrude(10)
        with self.assertRaisesRegex(ValueError, "planar"):
            apply(cylinder, {"type": "offset_face", "points": [[5, 0, 5]], "distance": 1})


class Ribs(unittest.TestCase):
    def test_gusset_in_a_corner(self):
        wall = cq.Workplane().box(4, 30, 20).translate((-16, 0, 15))
        bracket = block().union(wall)
        before = volume(bracket)
        out = apply(bracket, {"type": "rib", "origin": [-14, 0, 5], "vector": [0, 1, 0], "normal": UP, "normal2": [1, 0, 0], "thickness": 2, "size": 8})
        self.assertAlmostEqual(volume(out) - before, 8 * 8 / 2 * 2, delta=3.0)

    def test_parallel_faces_have_no_corner(self):
        with self.assertRaisesRegex(ValueError, "parallel"):
            apply(block(), {"type": "rib", "origin": [0, 0, 5], "vector": [0, 1, 0], "normal": UP, "normal2": UP, "thickness": 2, "size": 8})


class RemoveFeature(unittest.TestCase):
    def test_boss_comes_off(self):
        out = apply(block(), {"type": "boss", "origin": [0, 0, 5], "normal": UP, "profile": "circle", "diameter": 6, "depth": 4})
        removed = apply(out, {"type": "remove", "points": [[3, 0, 7]]})
        self.assertAlmostEqual(volume(removed), BLOCK, places=1)

    def test_fillet_is_taken_off(self):
        rounded = block().edges("|Z and >X and >Y").fillet(3)
        sharp = apply(rounded, {"type": "remove", "points": [[20 - 3 + 3 * math.cos(math.pi / 4), 15 - 3 + 3 * math.sin(math.pi / 4), 0]]})
        self.assertAlmostEqual(volume(sharp), BLOCK, places=1)

    def test_a_plain_face_is_not_a_feature(self):
        with self.assertRaises(ValueError):
            apply(block(), {"type": "remove", "points": [[0, 0, 5]]})


class Delete(unittest.TestCase):
    """Delete picks fill or remove from the geometry the selected face belongs to."""

    def test_a_boss_is_removed(self):
        out = apply(block(), {"type": "boss", "origin": [0, 0, 5], "normal": UP, "profile": "circle", "diameter": 6, "depth": 4})
        self.assertAlmostEqual(volume(apply(out, {"type": "delete", "points": [[3, 0, 7]]})), BLOCK, places=1)

    def test_a_pocket_is_filled_from_its_floor_or_wall(self):
        pocket = apply(block(), {"type": "pocket", "origin": [0, 0, 5], "normal": UP, "profile": "rect", "width": 10, "height": 6, "depth": 3})
        self.assertAlmostEqual(volume(apply(pocket, {"type": "delete", "points": [[0, 0, 2]]})), BLOCK, places=1)
        self.assertAlmostEqual(volume(apply(pocket, {"type": "delete", "points": [[5, 0, 3.5]]})), BLOCK, places=1)

    def test_a_hole_is_filled(self):
        drilled = apply(block(), {"type": "hole", "origin": [0, 0, 5], "normal": UP, "diameter": 4})
        self.assertAlmostEqual(volume(apply(drilled, {"type": "delete", "points": [[2, 0, 0]]})), BLOCK, places=1)

    def test_a_fillet_is_deleted(self):
        rounded = block().edges("|Z and >X and >Y").fillet(3)
        point = [20 - 3 + 3 * math.cos(math.pi / 4), 15 - 3 + 3 * math.sin(math.pi / 4), 0]
        self.assertAlmostEqual(volume(apply(rounded, {"type": "delete", "points": [point]})), BLOCK, places=1)

    def test_a_boss_and_a_pocket_together(self):
        both = apply(
            block(),
            {"type": "boss", "origin": [10, 0, 5], "normal": UP, "profile": "circle", "diameter": 4, "depth": 3},
            {"type": "pocket", "origin": [-10, 0, 5], "normal": UP, "profile": "circle", "diameter": 4, "depth": 3},
        )
        out = apply(both, {"type": "delete", "points": [[12, 0, 6], [-10, 0, 2]]})
        self.assertAlmostEqual(volume(out), BLOCK, places=1)

    def test_a_plain_outer_face_is_refused(self):
        with self.assertRaises(ValueError):
            apply(block(), {"type": "delete", "points": [[0, 0, 5]]})


class Drafts(unittest.TestCase):
    def test_side_wall_tilts(self):
        out = apply(block(), {"type": "draft", "origin": [0, 0, -5], "normal": UP, "angle": 5, "points": [[20, 0, 0]]})
        self.assertNotAlmostEqual(volume(out), BLOCK, places=1)

    def test_top_face_cannot_be_drafted(self):
        with self.assertRaisesRegex(ValueError, "square"):
            apply(block(), {"type": "draft", "origin": [0, 0, -5], "normal": UP, "angle": 5, "points": [[0, 0, 5]]})


class Text(unittest.TestCase):
    def test_emboss_and_engrave(self):
        raised = apply(block(), {"type": "text", "origin": [0, 0, 5], "normal": UP, "text": "A1", "size": 8, "distance": 1})
        self.assertGreater(volume(raised), BLOCK + 1)
        cut = apply(block(), {"type": "text", "origin": [0, 0, 5], "normal": UP, "text": "A1", "size": 8, "distance": -1})
        self.assertLess(volume(cut), BLOCK - 1)


class Combine(unittest.TestCase):
    @staticmethod
    def step_of(shape):
        import base64
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "other.step"
            cq.exporters.export(shape, str(path))
            return base64.b64encode(path.read_bytes()).decode()

    def test_union_subtract_intersect(self):
        other = cq.Workplane().box(20, 30, 10).translate((20, 0, 0))  # spans x 10..30, overlapping x 10..20
        encoded = self.step_of(other)
        union = apply(block(), {"type": "combine", "mode": "union", "other_step": encoded})
        self.assertAlmostEqual(volume(union), BLOCK + 20 * 30 * 10 - 10 * 30 * 10, places=0)
        cut = apply(block(), {"type": "combine", "mode": "subtract", "other_step": encoded})
        self.assertAlmostEqual(volume(cut), BLOCK - 10 * 30 * 10, places=0)
        common = apply(block(), {"type": "combine", "mode": "intersect", "other_step": encoded})
        self.assertAlmostEqual(volume(common), 10 * 30 * 10, places=0)

    def test_no_overlap_is_refused(self):
        far = self.step_of(cq.Workplane().box(5, 5, 5).translate((100, 0, 0)))
        with self.assertRaisesRegex(ValueError, "left nothing"):
            apply(block(), {"type": "combine", "mode": "intersect", "other_step": far})


if __name__ == "__main__":
    unittest.main()
