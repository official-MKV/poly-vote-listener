const { ethers } = require("ethers");
const { PrismaClient } = require("@prisma/client");
require("dotenv/config");

const prisma = new PrismaClient();

// Load contract ABI
const CONTRACT_ABI =
  require("./artifacts/contracts/elections.sol/ElectionContract.json").abi;

// Use contract address from environment
const CONTRACT_ADDRESS = process.env.ELECTION_CONTRACT_ADDRESS;

// Map to store active listeners by election ID
const activeListeners = new Map();
let lastSyncTime = null;

// Function to set up a listener for the main contract
async function setupMainContractListener() {
  console.log(`Setting up listener for main contract at ${CONTRACT_ADDRESS}`);

  if (!CONTRACT_ADDRESS) {
    console.error("Missing ELECTION_CONTRACT_ADDRESS in environment variables");
    return;
  }

  try {
    // Set up a websocket provider for better event handling
    let provider;
    if (process.env.POLYGON_WSS_URL) {
      // Use WebSocket provider if available (better for events)
      provider = new ethers.WebSocketProvider(process.env.POLYGON_WSS_URL);
      console.log("Using WebSocket provider for events");
    } else {
      // Fall back to HTTP provider
      provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
      console.log("Using HTTP provider for events (WebSocket recommended)");
    }

    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    // Listen to Voted events (with electionId parameter)
    contract.on("Voted", async (voter, electionId, positionIds, event) => {
      const timestamp = new Date().toISOString();
      console.log(
        `[${timestamp}] Vote detected from ${voter} for election ${electionId}`
      );

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

    // Listen for connection errors
    provider.on("error", (error) => {
      console.error(`Provider connection error: ${error.message}`);
      console.log("Will attempt to reconnect...");

      // Attempt to reconnect after a delay
      setTimeout(() => {
        console.log("Attempting to reconnect...");
        setupMainContractListener();
      }, 30000); // 30 second delay
    });

    console.log("Listener set up successfully");
    return contract;
  } catch (error) {
    console.error(`Error setting up contract listener: ${error.message}`);

    // Retry after delay
    console.log("Will retry in 60 seconds...");
    setTimeout(setupMainContractListener, 60000);

    return null;
  }
}

// Function to process a vote event
async function processVoteEvent(voter, electionId, positionIds) {
  try {
    console.log(`Processing vote from ${voter} for election ${electionId}`);

    // Record the vote in the database
    await prisma.vote.create({
      data: {
        election: { connect: { id: electionId } },
        voterAddress: voter,
        timestamp: new Date(),
        blockchainReference: true,
      },
    });

    console.log(`Vote recorded in database for election ${electionId}`);
  } catch (error) {
    console.error(`Error processing vote: ${error.message}`);
  }
}

// Function to fetch and process vote counts for all active elections
async function syncVoteCounts() {
  try {
    console.log("Syncing vote counts from blockchain...");
    lastSyncTime = new Date().toISOString();

    // Find all active elections
    const activeElections = await prisma.election.findMany({
      where: {
        status: "ACTIVE",
        liveStatus: "LIVE",
        smartContractId: { not: null },
      },
      select: {
        id: true,
        title: true,
        smartContractId: true,
      },
    });

    console.log(`Found ${activeElections.length} active elections to sync`);

    // Create a provider
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    // Process each election
    for (const election of activeElections) {
      try {
        console.log(`Syncing votes for election: ${election.title}`);

        // Get positions for this election
        const positions = await prisma.position.findMany({
          where: { electionId: election.id },
          include: { candidates: true },
        });

        // For each position, get votes for each candidate
        for (const position of positions) {
          for (const candidate of position.candidates) {
            try {
              // Get vote count from blockchain
              const voteCount = await contract.getCandidateVotes(
                election.id,
                position.id,
                candidate.id
              );

              console.log(
                `Election: ${election.title}, Position: ${position.title}, ` +
                  `Candidate: ${candidate.id}, Votes: ${voteCount}`
              );

              // Update vote count in database
              await prisma.candidate.update({
                where: { id: candidate.id },
                data: { voteCount: Number(voteCount) },
              });
            } catch (error) {
              console.error(
                `Error getting votes for candidate ${candidate.id}: ${error.message}`
              );
            }
          }
        }

        console.log(`Completed sync for election: ${election.title}`);
      } catch (error) {
        console.error(
          `Error syncing votes for election ${election.title}: ${error.message}`
        );
      }
    }

    console.log("Vote count sync completed");
  } catch (error) {
    console.error(`Error in syncVoteCounts: ${error.message}`);
  }
}

// Send a heartbeat to indicate the service is running
function sendHeartbeat() {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] Listener heartbeat - Service running`);
}

// Start the listener manager
async function main() {
  console.log("Starting blockchain event listener...");

  try {
    // Set up listener for the main contract
    const contract = await setupMainContractListener();

    if (!contract) {
      console.error("Failed to set up contract listener, will retry...");
      // Retry after a delay rather than exiting
      setTimeout(main, 60000); // 1 minute
      return;
    }

    // Do an initial sync of vote counts
    await syncVoteCounts();

    // Periodically sync vote counts (every 5 minutes)
    setInterval(syncVoteCounts, 5 * 60 * 1000);

    // Send a heartbeat every minute to show the service is alive
    setInterval(sendHeartbeat, 60 * 1000);

    console.log("Listener manager running successfully");
  } catch (error) {
    console.error("Error starting listener manager:", error);

    // Retry after a delay rather than exiting
    console.log("Will retry in 60 seconds...");
    setTimeout(main, 60000);
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

// Handle uncaught exceptions to prevent crashing
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  // Keep the process running
});

// Start the listener manager
main().catch((error) => {
  console.error("Fatal error in listener manager:", error);
  // Retry after a delay rather than exiting
  console.log("Will retry in 60 seconds...");
  setTimeout(main, 60000);
});
