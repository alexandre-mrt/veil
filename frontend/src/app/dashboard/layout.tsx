// Force dynamic rendering for the dashboard (wallet SDK references window/document at module level)
export const dynamic = "force-dynamic";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
