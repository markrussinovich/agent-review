#pragma once

namespace policy {
inline int limit(int attempts) {
    if (attempts < 0) return 0;
    if (attempts > 5) return 0;
    return attempts;
}
}
