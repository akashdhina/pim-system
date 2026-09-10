const { createPimCase } = require("../lib/pim");

const caseId = createPimCase({
  pimNumber: "TEST/01/2026",
  receivedNumber: "TEST-001",
  receivedDate: "2026-08-11",
  applicationDate: "2026-08-11",
  applicantName: "Test Applicant",
  oppositePartyName: "Test Opposite Party",
  oppositePartyAddress: "Test Address, Coonoor, The Nilgiris",
  claimAmount: 100000,
  disputeDescription: "Test commercial dispute"
});

console.log("Test PIM created successfully.");
console.log("Database ID:", caseId);