from typing import List

class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        """
        Returns indices of the two numbers such that they add up to target.
        Exactly one solution is guaranteed and the same element cannot be used twice.
        """
        seen = {}  # maps number -> its index
        for i, num in enumerate(nums):
            complement = target - num
            if complement in seen:
                return [seen[complement], i]
            seen[num] = i
        # According to the problem statement, a solution always exists,
        # so this line should never be reached.
        return []