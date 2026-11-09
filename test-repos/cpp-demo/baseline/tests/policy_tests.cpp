#include "../include/policy.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>

#define TEST(suite, name) void suite##_##name()
#define EXPECT_EQ(actual, expected) assert((actual) == (expected))

TEST(Policy, allows_boundary) {
    EXPECT_EQ(policy::limit(3), 3);
}

TEST(Policy, rejects_excess) {
    EXPECT_EQ(policy::limit(6), 0);
}

int main(int argc, char** argv) {
    const char* filter = argc > 1 ? argv[1] : "";
    if (std::strcmp(filter, "--gtest_filter=Policy.allows_boundary") == 0) {
        Policy_allows_boundary();
        std::puts("[       OK ] Policy.allows_boundary");
    } else if (std::strcmp(filter, "--gtest_filter=Policy.rejects_excess") == 0) {
        Policy_rejects_excess();
        std::puts("[       OK ] Policy.rejects_excess");
    } else {
        std::puts("No matching test.");
        return 2;
    }
}
