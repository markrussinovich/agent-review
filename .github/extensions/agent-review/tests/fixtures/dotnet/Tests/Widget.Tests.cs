using Xunit;

namespace Demo.Tests;

public class WidgetTests
{
    [Fact]
    public void ScoresThreshold()
    {
        Assert.Equal(0, new Widget().Score(15));
    }

    [Theory]
    [InlineData(25, 1)]
    [InlineData(125, 2)]
    public void ScoresPatterns(int value, int expected)
    {
        Assert.Equal(expected, new Widget().Score(value));
    }
}
