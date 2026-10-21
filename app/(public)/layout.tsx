export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6 supports-[height:100dvh]:min-h-dvh">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
