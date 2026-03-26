import backendApp from "../backend/app.cjs";

export default async function handler(req, res) {
  return backendApp.handleNodeRequest(req, res, {
    routeOverride: "/privacy"
  });
}
