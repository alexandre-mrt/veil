import dynamic from "next/dynamic";

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
