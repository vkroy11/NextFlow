export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const url =
      process.env.CANDIDATE_LINKEDIN_URL ??
      "https://www.linkedin.com/in/vishal-roy-2a4955233/";
    console.log(`[NextFlow] Candidate LinkedIn: ${url}`);
  }
}
