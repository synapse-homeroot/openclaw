// Googlechat plugin module validates outbound media link fallbacks.
import { formatTextWithAttachmentLinks } from "openclaw/plugin-sdk/reply-payload";

const GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE =
  "Google Chat outbound attachments require remote HTTP(S) URLs; native, local, and non-web attachments are not supported by this service-account channel.";

export function validateGoogleChatRemoteMediaUrls(
  mediaUrls: readonly string[],
  options?: { hasLocalMedia?: boolean },
): string[] {
  if (options?.hasLocalMedia) {
    throw new Error(GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE);
  }

  return mediaUrls.map((value) => {
    const mediaUrl = value.trim();
    try {
      const parsed = new URL(mediaUrl);
      if (
        /^https?:\/\//iu.test(mediaUrl) &&
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname
      ) {
        return mediaUrl;
      }
    } catch {
      // Fall through to the channel-specific unsupported-media error below.
    }
    throw new Error(GOOGLE_CHAT_UNSUPPORTED_OUTBOUND_MEDIA_MESSAGE);
  });
}

export function formatGoogleChatTextWithMediaLinks(params: {
  text?: string;
  mediaUrls: readonly string[];
  hasLocalMedia?: boolean;
}): string {
  return formatTextWithAttachmentLinks(
    params.text,
    validateGoogleChatRemoteMediaUrls(params.mediaUrls, {
      hasLocalMedia: params.hasLocalMedia,
    }),
  );
}
