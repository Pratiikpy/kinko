import QRCode from "qrcode";
import { useEffect, useState } from "react";

/**
 * A QR code drawn on the device. The encoded text never leaves the page: no
 * QR service is called, because a payment link's fragment carries its terms.
 */
export function QR({ value, label, size = 200 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(value, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size * 2,
      color: { dark: "#1b1815", light: "#ffffff" },
    })
      .then((url) => {
        if (live) setSrc(url);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [value, size]);
  if (failed)
    return (
      <p className="text-sm text-bad">
        This value is too long for a QR code. Share the link instead.
      </p>
    );
  return (
    <div
      className="inline-block rounded-2xl border border-line bg-white p-3"
      style={{ width: size + 24 }}
    >
      {src ? (
        <img src={src} width={size} height={size} alt={label} />
      ) : (
        <div style={{ width: size, height: size }} className="animate-pulse rounded bg-[#eee]" />
      )}
    </div>
  );
}
