import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Matrix OS - QR Code",
};

export default function QRPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-white px-6 py-12">
      <img
        src="/logo.png"
        alt="Matrix OS"
        className="size-12 rounded-xl mb-6"
      />
      <h1 className="text-lg font-bold tracking-tight text-[#111] mb-1">
        Matrix OS
      </h1>
      <p className="text-xs text-[#999] mb-8">
        Scan to learn more
      </p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https%3A%2F%2Fmatrix-os.com%2Fparty&format=svg&margin=0"
        alt="QR code to matrix-os.com/party"
        width={300}
        height={300}
        className="mb-6"
      />
      <p className="text-xs font-mono text-[#999]">
        matrix-os.com/party
      </p>
    </div>
  );
}
