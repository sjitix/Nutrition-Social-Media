import type { Metadata } from "next";
import { AccountClient } from "./AccountClient";

export const metadata: Metadata = {
  title: "Your data · NutriFlow",
  description: "Take your plan with you, bring it back, or delete it — and keep it in your account.",
};

/**
 * The account page. Everything on it is about data the person owns, so it is entirely client-side:
 * the server has nothing of theirs to render. Built by the accounts lane (docs/parallel/lane-accounts.md).
 */
export default function AccountPage() {
  return <AccountClient />;
}
