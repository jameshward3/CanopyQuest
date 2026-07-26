// Set this to the deployed OrangeTreeDatabase API origin.
// A local override can be saved as localStorage.orangeTreeDatabaseUrl.
let savedDatabaseUrl = null;
try { savedDatabaseUrl = localStorage.getItem("orangeTreeDatabaseUrl"); }
catch (_error) { /* Storage can be unavailable in private browsing. */ }
window.ORANGE_TREE_DATABASE_URL =
  savedDatabaseUrl ||
  window.ORANGE_TREE_DATABASE_URL ||
  "https://orange-tree-database.vercel.app";
