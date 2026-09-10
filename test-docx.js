const fs = require("fs");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");

const templatePath =
  "templates/pim/form3.docx";

const content =
  fs.readFileSync(templatePath);

const zip =
  new PizZip(content);

const doc =
  new Docxtemplater(zip, {
    delimiters: {
      start: "{{",
      end: "}}",
    },
    paragraphLoop: true,
    linebreaks: true,
  });

console.log("Template loaded.");

doc.render({
  applicant_name:
    "TEST APPLICANT",

  application_date:
    "13/08/2026",

  opposite_party_name:
    "TEST OPPOSITE",

  appearance_date:
    "26/08/2026",

  rule_reference:
    "3(6)",

  nonstarter_reason:
    "Opposite party refused to participate in mediation",

  outcome_date:
    "13/08/2026",
});

const output =
  doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });

fs.writeFileSync(
  "templates/pim/form3-test-output.docx",
  output
);

console.log(
  "SUCCESS: templates/pim/form3-test-output.docx"
);