// Set this to the deployed OrangeTreeDatabase API origin.
// A local override can be saved as localStorage.orangeTreeDatabaseUrl.
window.ORANGE_TREE_DATABASE_URL =
  localStorage.getItem("orangeTreeDatabaseUrl") ||
  window.ORANGE_TREE_DATABASE_URL ||
  "http://localhost:8787";
