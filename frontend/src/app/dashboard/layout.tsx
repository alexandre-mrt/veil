import dynamic from "next/dynamic";

export const runtime = "nodejs";
export const fetchCache = "force-no-store";

const Providers = dynamic(
  () => import("../providers").then((m) => m.Providers),
  { ssr: false },
);

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <Providers>{children}</Providers>;
}
