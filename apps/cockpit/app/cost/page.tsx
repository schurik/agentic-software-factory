import { CostPanel } from "@/components/cost/CostPanel";
import { PageHeader } from "@/components/ui";

// No longer in the nav (#105): the factory page absorbs it, and until then the route keeps working.
export default function CostPage() {
  return (
    <>
      <PageHeader title="Cost" />
      <CostPanel />
    </>
  );
}
