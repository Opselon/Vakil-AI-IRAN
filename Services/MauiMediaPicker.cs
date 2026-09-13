using VakilAI.Application.Contracts;

using Microsoft.Maui.Media;
using Microsoft.Maui.Storage;
using IMediaPicker = VakilAI.Application.Contracts.IMediaPicker;

namespace Vakil_AI_IRAN.Services;

/// <summary>
/// Picks a document photo (contract / court order) via the platform gallery.
/// Hard-caps the payload so a giant scan never reaches the API, and returns
/// null when the user cancels. The engine treats null as "nothing attached".
/// </summary>
public sealed class MauiMediaPicker : IMediaPicker
{
    /// <summary>Encoded image budget sent upstream (≈ Gemini inline-data comfort zone).</summary>
    public const long MaxBytes = 6L * 1024 * 1024;

    public async Task<CapturedImage?> PickDocumentPhotoAsync(int maxDimension = 1280, CancellationToken ct = default)
    {
        FileResult? file = null;
        try
        {
            // PickPhotosAsync is the non-obsolete API; it returns an empty list on cancel,
            // so we take the first photo only (the engine handles a single document image).
            var picked = await MediaPicker.PickPhotosAsync(new MediaPickerOptions
            {
                Title = "تصویر قرارداد یا دادنامه را انتخاب کنید",
                RotateImage = true,
                CompressionQuality = 80,
                MaximumWidth = maxDimension,
                MaximumHeight = maxDimension,
                SelectionLimit = 1
            });
            file = picked is { Count: > 0 } ? picked[0] : null;
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("pick photo: " + e.Message);
            return null;
        }

        if (file is null) return null;
        ct.ThrowIfCancellationRequested();

        byte[] data;
        try
        {
            await using var stream = await file.OpenReadAsync();
            using var buffer = new MemoryStream();
            await stream.CopyToAsync(buffer, ct);
            data = buffer.ToArray();
        }
        catch (Exception e)
        {
            System.Diagnostics.Debug.WriteLine("read photo: " + e.Message);
            throw new InvalidOperationException("خواندن تصویر انتخاب‌شده ممکن نشد.");
        }

        if (data.Length == 0) return null;
        if (data.Length > MaxBytes)
            throw new InvalidOperationException("حجم تصویر بیش از حد مجاز است؛ تصویر کوچک‌تری انتخاب کنید.");

        var mime = string.IsNullOrWhiteSpace(file.ContentType) ? "image/jpeg" : file.ContentType!;
        return new CapturedImage(data, mime, Math.Max(512, maxDimension));
    }
}
