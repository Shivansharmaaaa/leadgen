import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Leadgen",
  description: "AI lead generation and customer care for local service businesses",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
