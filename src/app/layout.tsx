import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { LinkedinAttribution } from "@/components/LinkedinAttribution";
import "./globals.css";
import "reactflow/dist/style.css";

const LINKEDIN_DEFAULT = "https://www.linkedin.com/in/vishal-roy-2a4955233/";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "NextFlow",
  description: "LLM workflow builder powered by Google Gemini",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read server-side so the env var doesn't need NEXT_PUBLIC_*. Fallback
  // matches the value src/instrumentation.ts uses on the server boot log.
  const linkedinUrl = process.env.CANDIDATE_LINKEDIN_URL ?? LINKEDIN_DEFAULT;
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col bg-canvas text-gray-900">
          <LinkedinAttribution url={linkedinUrl} />
          {children}
        </body>
      </html>
    </ClerkProvider>
  );
}
