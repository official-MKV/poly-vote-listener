const { ethers } = require("ethers");
const { PrismaClient } = require("@prisma/client");
require("dotenv/config");

const prisma = new PrismaClient();

// Load contract ABI - Update this to the new contract
const CONTRACT_ABI =
  require("./artifacts/contracts/elections.sol/ElectionContract.json").abi;

// Use a single contract address from environment
const CONTRACT_ADDRESS = process.env.ELECTION_CONTRACT_ADDRESS;

// Map to store active listeners by election ID
const activeListeners = new Map();

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
  try {
    // Get the vote details from the blockchain
    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    // For each position ID, find the corresponding candidate that was voted for
    for (const positionId of positionIds) {
      try {
        // Get the election and position details first
        const position = await prisma.position.findFirst({
          where: {
            id: positionId,
            electionId: electionId,
          },
          include: {
            candidates: true,
          },
        });

        if (!position) {
          console.warn(
            `Position ${positionId} not found in database for election ${electionId}`
          );
          continue;
        }

        // Find the student record from the wallet address if possible
        const student = await prisma.student.findFirst({
          where: {
            wallet: voter.toLowerCase(),
          },
        });

        if (!student) {
          console.warn(`No student found with wallet address ${voter}`);
          continue;
        }

        // Try to find the specific candidate that was voted for
        // This requires additional blockchain queries which we'll implement later
        // For now, we'll just use the first candidate as a placeholder
        const candidateId = position.candidates[0]?.id;

        if (!candidateId) {
          console.warn(`No candidates found for position ${positionId}`);
          continue;
        }

        // Check if vote already exists
        const existingVote = await prisma.vote.findFirst({
          where: {
            studentId: student.id,
            candidateId: candidateId,
          },
        });

        if (existingVote) {
          console.log(
            `Vote already recorded for student ${student.id} and candidate ${candidateId}`
          );
          continue;
        }

        // Create a vote record in the database
        await prisma.vote.create({
          data: {
            studentId: student.id,
            candidateId: candidateId,
          },
        });

        console.log(
          `Vote recorded for student ${student.id} for position ${position.title}`
        );
      } catch (error) {
        console.error(
          `Error processing vote for position ${positionId}: ${error.message}`
        );
      }
    }
  } catch (error) {
    console.error(`Error in processVoteEvent: ${error.message}`);
  }
}

// Function to fetch and process vote counts for all active elections
async function syncVoteCounts() {
  try {
    console.log("Syncing vote counts from blockchain...");

    // Fetch active elections from the database
    const elections = await prisma.election.findMany({
      where: {
        liveStatus: "LIVE",
        smartContractId: {
          not: null,
        },
      },
      include: {
        positions: {
          include: {
            candidates: true,
          },
        },
      },
    });

    const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
    const contract = new ethers.Contract(
      CONTRACT_ADDRESS,
      CONTRACT_ABI,
      provider
    );

    for (const election of elections) {
      console.log(`Syncing votes for election: ${election.title}`);

      try {
        // Get election data from blockchain
        const electionData = await contract.getElection(election.id);

        // electionData[5] contains the positions array
        const positions = electionData[5];

        for (const blockchainPosition of positions) {
          // Find matching position in database
          const dbPosition = election.positions.find(
            (p) => p.id === blockchainPosition.id
          );

          if (!dbPosition) {
            console.warn(
              `Position ${blockchainPosition.id} not found in database`
            );
            continue;
          }

          for (let i = 0; i < blockchainPosition.candidates.length; i++) {
            const blockchainCandidate = blockchainPosition.candidates[i];

            // Find matching candidate in database
            const dbCandidate = dbPosition.candidates.find(
              (c) => c.id === blockchainCandidate.id
            );

            if (!dbCandidate) {
              console.warn(
                `Candidate ${blockchainCandidate.id} not found in database`
              );
              continue;
            }

            // Get vote count from blockchain
            const voteCount = Number(blockchainCandidate.voteCount);

            // Count current votes in database
            const dbVoteCount = await prisma.vote.count({
              where: {
                candidateId: dbCandidate.id,
              },
            });

            // If blockchain has more votes than database, add the missing votes
            if (voteCount > dbVoteCount) {
              console.log(
                `Adding ${
                  voteCount - dbVoteCount
                } missing votes for candidate ${dbCandidate.id}`
              );

              // We need to find students who haven't voted yet to attribute these votes
              // For now, we'll just create "anonymous" votes by finding eligible students
              const eligibleStudents = await prisma.student.findMany({
                where: {
                  eligible: true,
                  // Exclude students who already voted for this candidate
                  NOT: {
                    Vote: {
                      some: {
                        candidateId: dbCandidate.id,
                      },
                    },
                  },
                },
                take: voteCount - dbVoteCount,
              });

              // Create missing votes
              for (const student of eligibleStudents) {
                try {
                  await prisma.vote.create({
                    data: {
                      studentId: student.id,
                      candidateId: dbCandidate.id,
                    },
                  });
                } catch (err) {
                  console.error(`Error creating vote: ${err.message}`);
                  // Continue with other students
                }
              }
            }
          }
        }

        console.log(`Completed sync for election: ${election.title}`);
      } catch (error) {
        console.error(
          `Error syncing election ${election.id}: ${error.message}`
        );
      }
    }

    console.log("Vote count sync completed");
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
