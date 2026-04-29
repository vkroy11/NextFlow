import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen flex-1 flex-col overflow-hidden bg-canvas">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-node-border bg-white px-5">
        <Link href="/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
            <Sparkles size={14} />
          </span>
          <span className="text-[15px] tracking-tight text-gray-900">NextFlow</span>
        </Link>
        <UserButton />
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}
