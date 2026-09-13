namespace VakilAI.Application;

/// <summary>Tiny logger abstraction so infrastructure can plug in any backend (D-7).</summary>
public interface ILogger
{
    void Info(string message);
    void Warn(string message);
    void Error(string message);
}

public sealed class NullLogger : ILogger
{
    public static readonly NullLogger Instance = new();
    public void Info(string message) { }
    public void Warn(string message) { }
    public void Error(string message) { }
}
