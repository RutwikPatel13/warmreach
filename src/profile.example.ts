// Copy this file to src/profile.ts and fill in your details.
// src/profile.ts is git-ignored — your personal info stays local.

export const profile = {
  fullName: "Jane Doe",
  location: "San Francisco, CA",
  email: "jane.doe@example.com",
  linkedin: "https://www.linkedin.com/in/janedoe",
  portfolio: "https://janedoe.dev",
  // Short tag appended to the subject line, e.g. "Software Engineer application — Jane Doe (recent CS grad)".
  // Leave empty ("") to omit.
  subjectTag: "recent CS grad",
  resumePath: "/Users/you/Documents/Resume/My_Resume.pdf",
  // Folder the web app's resume picker scans — every PDF under it becomes an option.
  resumeDir: "/Users/you/Documents/Resume",

  // One-line education framing reused in every email.
  educationLine:
    "I recently completed my BS in Computer Science and have hands-on experience building production systems.",

  // These bullets are kept VERBATIM in every email (no LLM paraphrasing).
  experienceBullets: [
    "Software Engineering: Shipped end-to-end features in production using <your stack>.",
    "Backend & Systems: <a systems/scalability bullet>.",
    "Applied AI & Automation: <an applied-AI or automation bullet>.",
    "Impact: <a concrete impact bullet with a number>.",
  ],

  // Signature is kept VERBATIM.
  signature: [
    "Best regards,",
    "Jane Doe",
    "San Francisco, CA",
    "jane.doe@example.com",
    "LinkedIn: https://www.linkedin.com/in/janedoe",
    "Portfolio: https://janedoe.dev",
  ].join("\n"),
};
