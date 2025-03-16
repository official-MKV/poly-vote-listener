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
          await processVoteEvent(voter, electionId, positionIds, event);
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
async function processVoteEvent(voter, electionId, positionIds, event) {
  try {
    console.log(`Processing vote from ${voter} for election ${electionId}`);
    console.log(`Position IDs voted for: ${positionIds}`);

    // Get the election data from blockchain to find the vote details
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    try {
      // Find the student with this wallet address
      const student = await prisma.student.findFirst({
        where: {
          wallet: voter,
        },
      });

      if (!student) {
        console.warn(`No student found with wallet address ${voter}`);
        return;
      }

      // Get the full election data
      const onChainElection = await contract.getElection(electionId);

      if (!onChainElection || !onChainElection.positions) {
        console.warn(
          `Could not retrieve blockchain data for election ${electionId}`
        );
        return;
      }

      // For each position ID in the event
      for (const positionId of positionIds) {
        try {
          // Find the on-chain position
          const onChainPosition = onChainElection.positions.find(
            (p) => p.id === positionId
          );
          if (!onChainPosition) {
            console.warn(`Position ${positionId} not found in blockchain data`);
            continue;
          }

          // Find candidates for this position with most votes
          let maxVotes = 0;
          let votedCandidateId = null;

          for (const candidate of onChainPosition.candidates) {
            const votes = Number(candidate.voteCount);
            if (votes > maxVotes) {
              maxVotes = votes;
              votedCandidateId = candidate.id;
            }
          }

          if (!votedCandidateId) {
            console.warn(
              `Could not determine voted candidate for position ${positionId}`
            );
            continue;
          }

          console.log(
            `Detected vote for candidate ${votedCandidateId} in position ${positionId}`
          );

          // Check if this vote already exists
          const existingVote = await prisma.vote.findFirst({
            where: {
              studentId: student.id,
              candidateId: votedCandidateId,
            },
          });

          if (existingVote) {
            console.log(
              `Vote already exists for student ${student.id} and candidate ${votedCandidateId}`
            );
            continue;
          }

          // Create a vote record
          await prisma.vote.create({
            data: {
              student: { connect: { id: student.id } },
              candidate: { connect: { id: votedCandidateId } },
            },
          });

          console.log(
            `Created vote record for student ${student.id} and candidate ${votedCandidateId}`
          );
        } catch (error) {
          console.error(
            `Error processing position ${positionId}: ${error.message}`
          );
        }
      }
    } catch (error) {
      console.error(`Error retrieving blockchain data: ${error.message}`);
    }
  } catch (error) {
    console.error(`Error processing vote event: ${error.message}`);
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

        // Get the full election data from the blockchain
        const onChainElection = await contract.getElection(election.id);

        if (!onChainElection || !onChainElection.positions) {
          console.log(
            `No data found on blockchain for election: ${election.title}`
          );
          continue;
        }

        console.log(`Retrieved on-chain data for election: ${election.title}`);

        // Process each position
        for (const onChainPosition of onChainElection.positions) {
          const positionId = onChainPosition.id;

          // Process each candidate
          for (const onChainCandidate of onChainPosition.candidates) {
            const candidateId = onChainCandidate.id;
            const onChainVotes = Number(onChainCandidate.voteCount);

            // Get database vote count
            const dbVotes = await prisma.vote.count({
              where: {
                candidateId: candidateId,
              },
            });

            console.log(
              `Candidate ${candidateId}: On-chain votes = ${onChainVotes}, Database votes = ${dbVotes}`
            );

            // If there's a discrepancy, log it (we can't directly modify vote counts)
            if (onChainVotes !== dbVotes) {
              console.warn(
                `Vote count mismatch for candidate ${candidateId}: On-chain=${onChainVotes}, DB=${dbVotes}`
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
