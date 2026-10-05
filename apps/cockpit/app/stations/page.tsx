import { StationsRedirect } from "@/components/Stations";

// A factory's page holds its stations now (#118): an old link goes on to its
// Stations tab. Approving a station keeps its own route, /stations/approve.
export default function StationsPage() {
  return <StationsRedirect />;
}
