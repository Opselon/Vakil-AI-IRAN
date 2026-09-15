using Android.Content;
using Android.Media;
using Microsoft.Maui.ApplicationModel;
using VakilAI.Application.Contracts;

namespace Vakil_AI_IRAN.Platforms.AndroidSupport;

// ═══════════════════════════════════════════════════════════════════════════
// PURPOSE   — Real microphone capture behind the existing IAudioRecorder port.
//             The AI engine accepts base64 audio + a mime and transcribes it,
//             so this only needs to produce a small, speech-grade clip:
//             AAC in an .m4a container at 16 kHz mono — the worker's own
//             default is "audio/mp4" when the client omits the mime, which this
//             matches exactly. Files go to the cache dir and die with the clip.
// LIFECYCLE — one instance registered as singleton; state transitions guarded
//             (Start → recording; Stop → captured; Cancel → discarded).
// PERMISSION— RECORD_AUDIO is requested at Start time (manifest already
//             declares it); a denial reads as "no permission" not "no device".
// OWNER     — coordinator (premium rebuild).
// ═══════════════════════════════════════════════════════════════════════════

public sealed class AndroidAudioRecorder : IAudioRecorder
{
    private const int MaxSeconds = 60;
    private const string MimeType = "audio/mp4";

    private MediaRecorder? _recorder;
    private string? _path;
    private DateTime _startedAt;

    public bool IsAvailable => true;

    public async Task<bool> HasPermissionAsync()
    {
        try
        {
            var status = await Permissions.RequestAsync<Permissions.Microphone>();
            return status == PermissionStatus.Granted;
        }
        catch { return false; }
    }

    public Task StartAsync(CancellationToken ct = default)
    {
        StopInternal(deleteFile: true);   // release any stale recorder before reuse

        _path = Path.Combine(FileSystem.CacheDirectory,
            "vakil-voice-" + DateTime.UtcNow.ToString("yyyyMMddHHmmssfff") + ".m4a");

        var recorder = CreateRecorder();
        try
        {
            recorder.SetAudioSource(AudioSource.Mic);
            recorder.SetOutputFormat(OutputFormat.Mpeg4);
            recorder.SetAudioEncoder(AudioEncoder.Aac);
            recorder.SetAudioSamplingRate(16000);
            recorder.SetAudioChannels(1);
            recorder.SetAudioEncodingBitRate(32000);
            recorder.SetMaxDuration(MaxSeconds * 1000);
            recorder.SetOutputFile(_path);
            recorder.Prepare();
            recorder.Start();
        }
        catch
        {
            recorder.Release();
            try { if (_path is not null) File.Delete(_path); } catch { }
            _path = null;
            throw;
        }

        _recorder = recorder;
        _startedAt = DateTime.UtcNow;
        return Task.CompletedTask;
    }

    private static MediaRecorder CreateRecorder()
    {
        // The parameterless ctor is "deprecated" since API 31 in favor of the
        // builder, which Mono.Android's net10 binding does not expose as a
        // nested type — the plain ctor remains fully functional down to minSdk 21.
#pragma warning disable CS0618
        return new MediaRecorder();
#pragma warning restore CS0618
    }

    public Task<CapturedAudio> StopAndCaptureAsync(CancellationToken ct = default)
    {
        if (_recorder is null || _path is null)
            return Task.FromException<CapturedAudio>(new InvalidOperationException("not recording"));

        int seconds = Math.Max(1, (int)Math.Round((DateTime.UtcNow - _startedAt).TotalSeconds));
        StopInternal(deleteFile: false);

        try
        {
            var data = File.ReadAllBytes(_path);
            if (data.Length < 512)
                return Task.FromException<CapturedAudio>(new InvalidOperationException("recording too short"));
            return Task.FromResult(new CapturedAudio(data, MimeType, seconds));
        }
        finally
        {
            try { File.Delete(_path); } catch { }
            _path = null;
        }
    }

    public Task CancelAsync()
    {
        StopInternal(deleteFile: true);
        return Task.CompletedTask;
    }

    private void StopInternal(bool deleteFile)
    {
        if (_recorder is not null)
        {
            try { _recorder.Stop(); } catch { /* cancelled or stale — the file is discarded anyway */ }
            try { _recorder.Reset(); } catch { }
            _recorder.Release();
            _recorder = null;
        }
        if (deleteFile && _path is not null)
        {
            try { File.Delete(_path); } catch { }
            _path = null;
        }
    }
}
