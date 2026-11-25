# EPLPS prototype flow

Read each diagram from top to bottom in the **App flow** column. Arrows to the right show what the app commits to or reads from the Cosmos EVM chain. Question files and holder packages travel off chain; question decryption happens in the center’s browser.

## 1. Set up the exam and generate paper sets

```mermaid
flowchart TB
  subgraph SETUP[1 · Admin sets up the exam]
    direction LR
    A[Registers submitters, holders, and centers;<br/>assigns shifts and sets deadlines] -->|setup transactions| A1[Chain stores exam configuration<br/>and opens submissions]
  end
  subgraph SUBMIT[2 · Submitters prepare and submit questions]
    direction LR
    B[Each submitter encrypts 50 questions;<br/>splits each question key into 5 Shamir shares<br/>so any 3 can rebuild it;<br/>encrypts each share to its holder and<br/>uploads ciphertexts to S3] -->|one batch transaction per submitter| B1[Chain stores question hashes and metadata,<br/>plus all 5 encrypted shares per question]
  end
  subgraph CLOSE[3 · Admin closes submissions]
    direction LR
    C[After all 9 submitters finish,<br/>admin closes submissions] -->|close transaction| C1[Chain changes the exam phase]
  end
  subgraph RANDOM[4 · Committee and relayer provide randomness]
    direction LR
    D[Committee members commit and reveal secrets;<br/>relayer submits public randomness] -->|commit, reveal, and randomness transactions| D1[Chain checks commitments<br/>and records valid randomness]
  end
  subgraph GENERATE[5 · Contract creates the paper sets]
    direction LR
    E[Contract derives a seed, shuffles question pools,<br/>and assigns 75 questions to each of 6 shifts] -->|generation transaction| E1[Chain stores the seed<br/>and six ordered question lists]
  end

  SETUP --> SUBMIT --> CLOSE --> RANDOM --> GENERATE
```

## 2. Center fetches its paper

```mermaid
flowchart TB
  subgraph CONNECT[1 · Center connects]
    direction LR
    A[Center connects its registered wallet<br/>and loads its private center key] -->|read| A1[Chain confirms the center<br/>and its assigned shift]
  end
  subgraph FETCH[2 · Center fetches its encrypted paper]
    direction LR
    B[App gets the 75-question manifest;<br/>center downloads ciphertexts;<br/>browser checks each file hash] -->|read| B1[Chain provides question IDs<br/>and committed ciphertext hashes]
  end
  subgraph REQUEST[3 · Center requests keys at the right time]
    direction LR
    C[Wait for the assigned key window<br/>T−15 minutes to T+30 minutes;<br/>center requests keys] -->|requestKeys transaction| C1[Chain checks the center and window;<br/>records KeyRequested]
  end
  subgraph SHARES[4 · Key holders release shares]
    direction LR
    D[Five holders verify the request;<br/>at least 3 return their shares encrypted<br/>to this center’s public key] -->|holders read verified shares| D1[Chain contains the holder-encrypted shares<br/>and holder identities]
  end
  subgraph BUILD[5 · Center builds the paper]
    direction LR
    E[Browser decrypts and combines 3 shares per question,<br/>decrypts and verifies questions,<br/>then arranges the assigned set] -->|read shift order and seed| E1[Chain provides this shift’s question order<br/>and the shuffle seed]
  end
  subgraph OUTPUT[6 · Paper is ready]
    direction LR
    F[Center downloads or prints the paper;<br/>correct answers are excluded]
  end

  CONNECT --> FETCH --> REQUEST --> SHARES --> BUILD --> OUTPUT
```

### What stays off chain

- Plaintext questions and encrypted question files are stored off chain; the files live in S3-compatible object storage.
- Holder packages are sent to the center by the key-holder services.
- The center reconstructs question keys and creates the printable paper in its browser.
