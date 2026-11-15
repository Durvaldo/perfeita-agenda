import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/current-user";
import { platformEnabled } from "@/server/platform/config";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar · Agenda da Barbearia" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  // Already signed in → straight to the panel (legacy "guest" route meta).
  if (await getCurrentUser()) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <LoginForm platformLogin={platformEnabled()} initialError={error ?? null} />
    </main>
  );
}
