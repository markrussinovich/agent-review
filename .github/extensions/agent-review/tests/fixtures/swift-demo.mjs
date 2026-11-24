export const baseline = {
    "Package.swift": `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ReviewDemo",
    products: [.library(name: "Core", targets: ["Core"])],
    dependencies: [],
    targets: [
        .target(name: "Core"),
        .testTarget(name: "CoreTests", dependencies: ["Core"])
    ]
)
`,
    "Sources/Core/Policy.swift": `public protocol Scoring {
    func score(_ value: Int) -> Int
}
public func score(_ value: Int) -> Int {
    guard value >= 0 else { return 0 }
    if value > 3 {
        return 10
    }
    return value
}
public actor Store {
    public init() {}
    public func read() -> Int { return 1 }
}
`,
    "Sources/Core/Caller.swift": `public func quote(_ value: Int) -> Int {
    return score(value)
}
`,
    "Tests/CoreTests/PolicyTests.swift": `import XCTest
@testable import Core
final class PolicyTests: XCTestCase {
    func testScore() {
        XCTAssertEqual(score(6), 10)
    }
}
`,
    "Tests/CoreTests/PolicyChecks.swift": `import Testing
@testable import Core
@Suite struct PolicyChecks {
    @Test("large values")
    func scoreLarge() {
        #expect(score(6) == 10)
    }
}
`,
};
export const current = { ...baseline, "Sources/Core/Policy.swift": baseline["Sources/Core/Policy.swift"].replace("value > 3", "value > 5") };
