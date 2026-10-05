"""Assert the generated solution passes the Two Sum samples."""
from typing import List
import importlib.util
import os

here = os.path.dirname(os.path.abspath(__file__))
sol_path = os.path.join(here, "generated_solution.py")
spec = importlib.util.spec_from_file_location("gen", sol_path)
gen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gen)

cls = None
for name in ("Solution", "solution"):
    cls = getattr(gen, name, None)
    if cls is not None:
        break
assert cls is not None, "No Solution class in generated code"

instance = cls()
method = None
for attr in dir(instance):
    if attr.startswith("two") or attr in ("solve", "sum"):
        method = getattr(instance, attr)
        break
assert method is not None, "No two-sum method found"

cases = [
    (([2, 7, 11, 15], 9), [0, 1]),
    (([3, 2, 4], 6), [1, 2]),
    (([3, 3], 6), [0, 1]),
]
for (nums, target), expected in cases:
    got = method(list(nums), target)
    assert sorted(got) == sorted(expected), f"FAIL: {nums}, {target} -> {got}, expected {expected}"
    print(f"PASS: {nums}, target={target} -> {got}")

print("\nALL SAMPLES PASS")
