import { redirect } from "next/navigation";

// The inbox becomes the home page once there is one; until then, the sessions.
export default function Home() {
  redirect("/sessions");
}
