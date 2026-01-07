export async function handler() {
  return {
    statusCode: 200,
    body: JSON.stringify({
      answer: "TEST OK – frontend ↔ backend funguje"
    })
  };
}
