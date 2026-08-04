import Link from "next/link";
import { Wordmark } from "@/components/icons";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 text-center">
      <Wordmark />
      <p className="font-display mt-8 text-6xl font-bold tracking-tight text-vio-deep">404</p>
      <h1 className="mt-2 text-xl font-bold">This page isn&rsquo;t on the menu</h1>
      <p className="mt-2 text-mut">
        The link may be old or mistyped. Let&rsquo;s get you back to your plan.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/plan"
          className="rounded-full bg-vio px-6 py-3 text-sm font-semibold text-white transition hover:bg-vio-deep"
        >
          Open my plan
        </Link>
        <Link
          href="/"
          className="rounded-full bg-white px-6 py-3 text-sm font-semibold text-plum ring-1 ring-line transition hover:ring-vio"
        >
          Go home
        </Link>
      </div>
    </main>
  );
}
