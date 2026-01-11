"use server";

import { createAdminClient, createSessionClient } from "@/lib/appwrite";
import { appwriteConfig } from "@/lib/appwrite/config";
import { Query, ID, Client, Account } from "node-appwrite";
import { parseStringify } from "@/lib/utils";
import { cookies } from "next/headers";
import { avatarPlaceholderUrl } from "@/constants";
import { redirect } from "next/navigation";

const getUserByEmail = async (email: string) => {
  const { databases } = await createAdminClient();

  const result = await databases.listDocuments(
    appwriteConfig.databaseId,
    appwriteConfig.usersCollectionId,
    [Query.equal("email", [email])],
  );

  return result.total > 0 ? result.documents[0] : null;
};

const handleError = (error: unknown, message: string) => {
  console.log(error, message);
  throw error;
};

export const sendEmailOTP = async ({ 
  email, 
  userId 
}: { 
  email: string; 
  userId?: string;
}) => {
  const { account } = await createAdminClient();

  try {
    // If userId is provided, use it; otherwise generate a new one
    // Important: If email already has an account in Appwrite, Appwrite will use that account's userId
    // not necessarily the one we pass. We need to use the userId returned from the token.
    const userIdToUse = userId || ID.unique();
    const token = await account.createEmailToken(userIdToUse, email);

    // The token response structure: { userId: string, ... }
    // The userId in the response is the actual account userId (existing or newly created)
    const actualUserId = (token as any).userId;
    
    if (!actualUserId) {
      console.warn("Token response doesn't contain userId, using provided userId:", userIdToUse);
      // If token doesn't have userId, we'll use what we passed (shouldn't happen but handle it)
      return { userId: userIdToUse };
    }
    
    console.log("Email OTP sent successfully, userId:", actualUserId, "email:", email);
    console.log("Token response:", JSON.stringify(token, null, 2));
    
    return { userId: actualUserId };
  } catch (error: any) {
    console.error("Error sending email OTP:", error);
    console.error("Error details:", JSON.stringify(error, null, 2));
    const errorMessage = error?.message || "Failed to send email OTP. Please try again.";
    throw new Error(errorMessage);
  }
};

export const createAccount = async ({
  fullName,
  email,
}: {
  fullName: string;
  email: string;
}) => {
  try {
    const existingUser = await getUserByEmail(email);

    // If user already exists in database, they should sign in instead
    if (existingUser) {
      throw new Error("An account with this email already exists. Please sign in instead.");
    }

    // For new users, generate userId and send OTP
    // createEmailToken will automatically create the Appwrite account if it doesn't exist
    const { userId } = await sendEmailOTP({ email });
    
    if (!userId) {
      throw new Error("Failed to send OTP");
    }

    // Store user data temporarily - we'll create the database document after OTP verification
    // For now, return the userId so OTP can be verified
    return parseStringify({ accountId: userId, fullName, email });
  } catch (error: any) {
    console.error("Error creating account:", error);
    // Re-throw with the same error message if it's already an Error object
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(error?.message || "Failed to create account. Please try again.");
  }
};

export const verifySecret = async ({
  accountId,
  password,
  fullName,
  email,
}: {
  accountId: string;
  password: string;
  fullName?: string;
  email?: string;
}) => {
  try {
    const { account, databases } = await createAdminClient();

    // Verify OTP and create session
    // accountId here is the userId returned from createEmailToken
    // password is the OTP code entered by the user
    console.log("Verifying OTP for userId:", accountId, "email:", email);
    
    let session;
    try {
      session = await account.createSession(accountId, password);
    } catch (sessionError: any) {
      console.error("Session creation error:", sessionError);
      // If session creation fails, the OTP might be invalid or expired
      if (sessionError?.code === 401 || sessionError?.message?.includes("Invalid token") || sessionError?.message?.includes("Invalid")) {
        throw new Error("Invalid or expired OTP. Please request a new one.");
      }
      throw sessionError;
    }

    // After creating session, get the actual account info to verify the userId
    // Create a temporary client with the session to get account info
    const tempClient = new Client()
      .setEndpoint(appwriteConfig.endpointUrl)
      .setProject(appwriteConfig.projectId)
      .setSession(session.secret);
    
    const accountApi = new Account(tempClient);
    const accountInfo = await accountApi.get();
    const actualAccountId = accountInfo.$id;

    console.log("Session created successfully, actual accountId:", actualAccountId, "original accountId:", accountId);

    // Check if user exists in database
    let existingUser = email ? await getUserByEmail(email) : null;

    // If new user (from sign-up) and not in database, create database document
    if (!existingUser && fullName && email) {
      try {
        // Create user document with accountId (schema has been corrected)
        const userData: any = {
          fullName: fullName.trim(),
          email: email.trim().toLowerCase(),
          avatar: avatarPlaceholderUrl,
          accountId: actualAccountId, // Use accountId (schema corrected)
        };
        
        const newUserDoc = await databases.createDocument(
          appwriteConfig.databaseId,
          appwriteConfig.usersCollectionId,
          ID.unique(),
          userData,
        );
        
        console.log("User document created successfully in database:", newUserDoc.$id);
        existingUser = newUserDoc;
      } catch (dbError: any) {
        console.error("Error creating user document:");
        console.error("Error message:", dbError?.message);
        console.error("Error code:", dbError?.code);
        console.error("Error type:", dbError?.type);
        console.error("Full error:", dbError);
        
        // Check again if user was created somehow (race condition)
        existingUser = await getUserByEmail(email);
        if (!existingUser) {
          // Provide clear error message
          const errorMsg = dbError?.message || "Unknown database error";
          throw new Error(`Failed to save user data: ${errorMsg}. Please ensure your Appwrite collection has the correct attributes: fullName, email, avatar, and accounId (or accountId).`);
        }
        console.log("User already exists in database, continuing...");
        
        // Update accountId if it's different
        const currentAccountId = existingUser.accountId;
        if (currentAccountId && currentAccountId !== actualAccountId) {
          try {
            await databases.updateDocument(
              appwriteConfig.databaseId,
              appwriteConfig.usersCollectionId,
              existingUser.$id,
              { accountId: actualAccountId }
            );
            console.log("Updated accountId in database");
          } catch (updateError) {
            console.error("Failed to update accountId:", updateError);
          }
        }
      }
    } else if (existingUser) {
      // If user exists, check if accountId needs updating
      const currentAccountId = existingUser.accountId;
      if (currentAccountId && currentAccountId !== actualAccountId) {
        try {
          await databases.updateDocument(
            appwriteConfig.databaseId,
            appwriteConfig.usersCollectionId,
            existingUser.$id,
            { accountId: actualAccountId }
          );
          console.log("Updated accountId in database for existing user");
        } catch (updateError) {
          console.error("Failed to update accountId:", updateError);
        }
      }
    }

    // Set session cookie with proper configuration
    const cookieStore = await cookies();
    cookieStore.set("appwrite-session", session.secret, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });

    console.log("Session cookie set successfully");

    return parseStringify({ sessionId: session.$id, success: true, accountId: actualAccountId });
  } catch (error: any) {
    console.error("Error verifying OTP:", error);
    console.error("Error code:", error?.code);
    console.error("Error type:", error?.type);
    console.error("Error response:", error?.response);
    
    // Handle specific error cases
    if (error?.code === 401 || error?.message?.toLowerCase().includes("invalid token") || error?.message?.toLowerCase().includes("invalid")) {
      throw new Error("Invalid or expired OTP. Please request a new one and try again.");
    }
    
    if (error?.message?.includes("expired")) {
      throw new Error("OTP has expired. Please request a new one.");
    }
    
    // If it's already an Error with a message, throw it as is
    if (error instanceof Error && error.message) {
      throw error;
    }
    
    throw new Error(error?.message || "Invalid OTP. Please try again.");
  }
};

export const getCurrentUser = async () => {
  try {
    const { databases, account } = await createSessionClient();

    const result = await account.get();

    if (!result || !result.$id) {
      console.log("No account found in session");
      return null;
    }

    // Find user by accountId
    const user = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.usersCollectionId,
      [Query.equal("accountId", result.$id)],
    );

    if (user.total <= 0) {
      console.log(`No user found in database for accountId: ${result.$id}`);
      return null;
    }

    return parseStringify(user.documents[0]);
  } catch (error: any) {
    console.error("Error getting current user:", error?.message || error);
    // Return null instead of undefined when there's an error (e.g., no session)
    return null;
  }
};

export const signOutUser = async () => {
  const { account } = await createSessionClient();

  try {
    await account.deleteSession("current");
    (await cookies()).delete("appwrite-session");
  } catch (error) {
    handleError(error, "Failed to sign out user");
  } finally {
    redirect("/sign-in");
  }
};

export const signInUser = async ({ email }: { email: string }) => {
  try {
    const existingUser = await getUserByEmail(email);

    // User must exist in database to sign in
    if (!existingUser) {
      console.log(`Sign-in attempt for email not in database: ${email}`);
      return parseStringify({ accountId: null, error: "User not found. Please sign up first." });
    }

    // Use existing accountId to send OTP
    // If accountId exists, use it; otherwise, let sendEmailOTP generate a new one
    const existingAccountId = existingUser.accountId;
    const { userId } = await sendEmailOTP({ 
      email, 
      userId: existingAccountId || undefined 
    });
    
    if (!userId) {
      throw new Error("Failed to send OTP");
    }

    console.log(`OTP sent successfully for sign-in: ${email}, userId: ${userId}`);
    return parseStringify({ accountId: userId });
  } catch (error: any) {
    console.error("Error signing in user:", error);
    throw new Error(error?.message || "Failed to sign in. Please try again.");
  }
};
