#include "include/policy.hpp"

int allowed_attempts(int attempts) {
    return policy::limit(attempts);
}
