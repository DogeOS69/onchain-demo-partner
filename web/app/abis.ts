export const eventEmitterAbi = [
  {
    type: "function",
    name: "trigger",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "function",
    name: "callsBy",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Triggered",
    inputs: [
      { name: "user", type: "address", indexed: true },
      { name: "count", type: "uint256", indexed: false },
    ],
  },
] as const;
