#include <bits/stdc++.h>
using namespace std;

class Solution {
public:
    vector<int> twoSum(vector<int>& nums, int target) {
        unordered_map<int, int> idx; // value -> index
        for (int i = 0; i < static_cast<int>(nums.size()); ++i) {
            int complement = target - nums[i];
            auto it = idx.find(complement);
            if (it != idx.end()) {
                return {it->second, i};
            }
            // Store the first occurrence of nums[i]
            idx[nums[i]] = i;
        }
        // According to the problem statement this line is never reached.
        return {};
    }
};