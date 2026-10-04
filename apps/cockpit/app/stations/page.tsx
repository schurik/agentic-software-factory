import { Stations } from "@/components/Stations";

// Your stations: the ones you approved to take commands, and their tokens to revoke. No longer
// in the nav (#105): the factory page absorbs it, and until then the route keeps working.
export default function StationsPage() {
  return <Stations />;
}
