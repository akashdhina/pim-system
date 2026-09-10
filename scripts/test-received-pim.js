const { createReceivedPimApplication } = require("../lib/pim");

const caseId = createReceivedPimApplication({
  receivedNumber: "TEST-REC-001",
  receivedDate: "2026-08-11",
  applicationDate: "2026-08-11",

  claimAmount: 500000,
  disputeDescription: "Test commercial dispute",

  applicants: [
    {
      name: "ABC Bank",
      entityType: "COMPANY",
      addresses: [
        {
          addressType: "POSTAL",
          addressLine1: "ABC Bank, Main Road",
          addressLine2: "Coonoor",
          villageTown: "Coonoor",
          district: "The Nilgiris",
          state: "Tamil Nadu",
          pincode: "643101"
        }
      ],
      advocate: {
        name: "Test Advocate",
        enrollmentNo: "TN/TEST/001",
        phone: "9999999999"
      }
    }
  ],

  oppositeParties: [
    {
      name: "Mr. Test Person",
      entityType: "INDIVIDUAL",
      addresses: [
        {
          addressType: "POSTAL",
          addressLine1: "1 Test Street",
          addressLine2: "Coonoor",
          villageTown: "Coonoor",
          district: "The Nilgiris",
          state: "Tamil Nadu",
          pincode: "643102"
        },
        {
          addressType: "ALTERNATE",
          addressLine1: "2 Alternate Street",
          villageTown: "Coimbatore",
          district: "Coimbatore",
          state: "Tamil Nadu",
          pincode: "641001"
        }
      ]
    },
    {
      name: "XYZ Private Limited",
      entityType: "COMPANY",
      addresses: [
        {
          addressType: "REGISTERED_OFFICE",
          addressLine1: "XYZ Pvt Ltd Registered Office",
          villageTown: "Coimbatore",
          district: "Coimbatore",
          state: "Tamil Nadu",
          pincode: "641002"
        }
      ]
    }
  ],

  applicationFee: {
    amount: 1000,
    ddNumber: "TEST-DD-001",
    ddDate: "2026-08-11",
    bankName: "Test Bank",
    payee: "Chairman, DLSA"
  }
});

console.log("Received PIM created.");
console.log("Database ID:", caseId);