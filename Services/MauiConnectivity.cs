using VakilAI.Application.Contracts;

using Microsoft.Maui.Networking;
using IConnectivity = VakilAI.Application.Contracts.IConnectivity;

namespace Vakil_AI_IRAN.Services;

/// <summary>MAUI Essentials connectivity port — pushes online/offline transitions to the engine.</summary>
public sealed class MauiConnectivity : IConnectivity, IDisposable
{
    public MauiConnectivity()
    {
        try { Connectivity.ConnectivityChanged += OnChanged; }
        catch (Exception e) { System.Diagnostics.Debug.WriteLine("connectivity hook: " + e.Message); }
    }

    public bool IsOnline
    {
        get
        {
            try { return Connectivity.NetworkAccess == NetworkAccess.Internet; }
            catch { return true; }
        }
    }

    public event EventHandler<bool>? Changed;

    private void OnChanged(object? sender, ConnectivityChangedEventArgs e)
    {
        var online = e.NetworkAccess == NetworkAccess.Internet;
        try { Changed?.Invoke(this, online); }
        catch (Exception ex) { System.Diagnostics.Debug.WriteLine("connectivity listener: " + ex.Message); }
    }

    public void Dispose()
    {
        try { Connectivity.ConnectivityChanged -= OnChanged; } catch { }
    }
}
