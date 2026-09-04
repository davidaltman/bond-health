/**
 * Bond-Daphne sandbox agent ids. Mirrors ../scripts/created_agents.json
 * (v2 ids as of 2026-08-16) -- kept as a separate small constant here
 * rather than importing the JSON across the frontend/server split, since
 * this file is meant to be hand-updated whenever the sandbox agents are
 * recreated (see push_to_sandbox.py / patch_sandbox_agent.py /
 * create_family_relative_agents.py).
 *
 * 2026-08-16: a 4-agent per-relative split (family_mother -> family_father
 * -> family_siblings -> family_grandparents) was tried as a replacement for
 * the single family_history agent, then reverted the same day after a live
 * call showed a new failure mode (a transferred-in agent immediately
 * re-transferring without asking its own question) plus noticeably worse
 * latency from the extra hops -- see 03_daphne_family_history.create.json's
 * notes for the full incident history. family_history is the live default
 * again (02's transfer_to_agent points here); the 4 split agents are kept
 * live and listed below for manual testing/experimentation only -- they are
 * NOT part of the default auto-chain from 02.
 */
export interface AgentOption {
  id: string;
  agentId: string;
  label: string;
  description: string;
}

export const BOND_AGENTS: AgentOption[] = [
  {
    id: "intake_consent",
    agentId: "agent_4201m063yfvqfjj8pm933nkfdywb",
    label: "1. Intake & Consent",
    description: "Greeting + explicit recording consent. Start here for a full run-through.",
  },
  {
    id: "personal_history",
    agentId: "agent_4801m063yf0bfpqszyjhrhp275gq",
    label: "2. Personal History",
    description: "Surgeries, medications, chronic conditions.",
  },
  {
    id: "family_history",
    agentId: "agent_0801m063ye0zf0985f1efqmgg90f",
    label: "3. Family History",
    description: "Per-relative condition history (mother, father, siblings, grandparents) in one agent. Live default -- 02 transfers here.",
  },
  {
    id: "family_mother",
    agentId: "agent_2401m0703zj6fjdb9xy2ezpkz1t9",
    label: "3a. Family History — Mother (parked, manual only)",
    description: "First of 4 per-relative split-agent stages. Not part of the default chain -- select manually to test this approach.",
  },
  {
    id: "family_father",
    agentId: "agent_7701m0703y9ge1rt5yv6gsfs39zm",
    label: "3b. Family History — Father (parked, manual only)",
    description: "Second of 4 per-relative split-agent stages. Not part of the default chain -- select manually to test this approach.",
  },
  {
    id: "family_siblings",
    agentId: "agent_1801m0703x8vecqsegjxr8hdqz3c",
    label: "3c. Family History — Siblings (parked, manual only)",
    description: "Third of 4 per-relative split-agent stages. Not part of the default chain -- select manually to test this approach.",
  },
  {
    id: "family_grandparents",
    agentId: "agent_4401m0703w8dep7974pkcm4f38et",
    label: "3d. Family History — Grandparents (parked, manual only)",
    description: "Last of 4 per-relative split-agent stages. Not part of the default chain -- select manually to test this approach.",
  },
  {
    id: "summary",
    agentId: "agent_6701m03g2y3yf3tt960cbzn3nwjt",
    label: "4. Summary",
    description: "Spoken recap, corrections, close.",
  },
];

export const DEFAULT_AGENT_ID = "intake_consent";
