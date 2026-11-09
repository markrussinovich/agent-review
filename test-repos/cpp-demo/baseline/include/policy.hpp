#pragma once

namespace policy {
inline int limit(int attempts) {
    if (attempts > 3) return 0;
    return attempts;
}
}
