const { ethers } = require("ethers");
const { PrismaClient } = require("@prisma/client");
require("dotenv/config");
const express = require("express");

const prisma = new PrismaClient();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Basic health check endpoint
app.get("/", (req, res) => {
  res.send({
    status: "up",
    message: "Blockchain listener is running",
    timestamp: new Date().toISOString(),
  });
});

// Status endpoint
app.get("/status", (req, res) => {
  res.json({
    status: "running",
    activeListeners: Array.from(activeListeners.keys()),
    lastSync: lastSyncTime,
  });
});

// Load contract ABI
const CONTRACT_ABI =
  require("./artifacts/contracts/elections.sol/ElectionContract.json").abi;

// Use contract address from environment
const CONTRACT_ADDRESS = process.env.ELECTION_CONTRACT_ADDRESS;

// Map to store active listeners by election ID
const activeListeners = new Map();
let lastSyncTime = null;

// Rest of your code remains the same
// Function to set up a listener for the main contract
async function setupMainContractListener() {
  console.log(`Setting up listener for main contract at ${CONTRACT_ADDRESS}`);

  if (!CONTRACT_ADDRESS) {
    console.error("Missing ELECTION_CONTRACT_ADDRESS in environment variables");
    return;
  }

  try {
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    // Listen to Voted events (with electionId parameter)
    contract.on("Voted", async (voter, electionId, positionIds) => {
      console.log(`Vote detected from ${voter} for election ${electionId}`);

      try {
        // Get the election from database to ensure it exists
        const election = await prisma.election.findUnique({
          where: { id: electionId },
          select: { id: true, title: true },
        });

        if (election) {
          console.log(`Processing vote for election: ${election.title}`);
          await processVoteEvent(voter, electionId, positionIds);
        } else {
          console.warn(`Received vote for unknown election ID: ${electionId}`);
        }
      } catch (error) {
        console.error(`Error processing vote event: ${error.message}`);
      }
    });

    console.log("Listener set up successfully");
    return contract;
  } catch (error) {
    console.error(`Error setting up contract listener: ${error.message}`);
    return null;
  }
}

// Function to process a vote event
async function processVoteEvent(voter, electionId, positionIds) {
  // Your existing code...
}

// Function to fetch and process vote counts for all active elections
async function syncVoteCounts() {
  try {
    console.log("Syncing vote counts from blockchain...");
    lastSyncTime = new Date().toISOString();

    // Rest of your syncVoteCounts function...
  } catch (error) {
    console.error(`Error in syncVoteCounts: ${error.message}`);
  }
}

// Start the listener manager
async function main() {
  console.log("Starting blockchain event listener...");

  try {
    // Set up listener for the main contract
    const contract = await setupMainContractListener();

    if (!contract) {
      console.error("Failed to set up contract listener, exiting");
      process.exit(1);
    }

    // Do an initial sync of vote counts
    await syncVoteCounts();

    // Periodically sync vote counts (every 5 minutes)
    setInterval(syncVoteCounts, 5 * 60 * 1000);

    console.log("Listener manager running");

    // Start the Express server
    app.listen(PORT, () => {
      console.log(`Express server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Error starting listener manager:", error);
    process.exit(1);
  }
}

// Handle process termination gracefully
process.on("SIGINT", async () => {
  console.log("Shutting down listener...");

  // Close any active listeners
  activeListeners.forEach((listener) => {
    if (listener.removeAllListeners) {
      listener.removeAllListeners();
    }
  });

  // Close database connection
  await prisma.$disconnect();

  console.log("Shutdown complete");
  process.exit(0);
});

// Start the listener manager
main().catch((error) => {
  console.error("Error in listener manager:", error);
  process.exit(1);
});
