namespace Demo;

public interface IWidget
{
    int Score(int? value);
}

public partial class Widget : IWidget
{
    public int Score(int? value)
    {
        if (value is null) throw new ArgumentNullException(nameof(value));
        if (value < 10) return 0;
        return value.Value switch
        {
            > 100 => 2,
            _ => 1
        };
    }

    public int Score(string value) => Score(int.Parse(value));
}
