"use server";

import { createAdminClient, createSessionClient } from "@/lib/appwrite";

import { appwriteConfig } from "@/lib/appwrite/config";
import { ID, Models, Query, Permission, Role } from "node-appwrite";
import { InputFile } from "node-appwrite/file";

import { constructFileUrl, getFileType, parseStringify } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/actions/user.actions";

const handleError = (error: unknown, message: string) => {
  console.log(error, message);
  throw error;
};

export const uploadFile = async ({
  file,
  ownerId,
  accountId,
  path,
}: UploadFileProps) => {
  const { storage, databases } = await createAdminClient();

  try {
    const inputFile = InputFile.fromBuffer(file, file.name);

    const bucketFile = await storage.createFile(
      appwriteConfig.bucketId,
      ID.unique(),
      inputFile,
    );

    const fileDocument = {
      type: getFileType(bucketFile.name).type,
      name: bucketFile.name,
      url: constructFileUrl(bucketFile.$id),
      extension: getFileType(bucketFile.name).extension,
      size: bucketFile.sizeOriginal,
      owner: ownerId,
      accountId,
      users: [],
      bucketFileId: bucketFile.$id,
    };

    const newFile = await databases
      .createDocument(
        appwriteConfig.databaseId,
        appwriteConfig.filesCollectionId,
        ID.unique(),
        fileDocument,
      )
      .catch(async (error: unknown) => {
        await storage.deleteFile(appwriteConfig.bucketId, bucketFile.$id);
        handleError(error, "Failed to create file document");
      });

    revalidatePath(path);
    return parseStringify(newFile);
  } catch (error) {
    handleError(error, "Failed to upload file");
  }
};

const createQueries = (
  currentUser: Models.Document,
  types: string[],
  searchText: string,
  sort: string,
  limit?: number,
) => {
  const queries = [
    Query.or([
      Query.equal("owner", [currentUser.$id]),
      Query.contains("users", [currentUser.email]),
    ]),
  ];

  if (types.length > 0) queries.push(Query.equal("type", types));
  if (searchText) queries.push(Query.contains("name", searchText));
  if (limit) queries.push(Query.limit(limit));

  if (sort) {
    const [sortBy, orderBy] = sort.split("-");

    queries.push(
      orderBy === "asc" ? Query.orderAsc(sortBy) : Query.orderDesc(sortBy),
    );
  }

  return queries;
};

export const getFiles = async ({
  types = [],
  searchText = "",
  sort = "$createdAt-desc",
  limit,
}: GetFilesProps) => {
  const { databases } = await createAdminClient();

  try {
    const currentUser = await getCurrentUser();

    if (!currentUser) throw new Error("User not found");

    const queries = createQueries(currentUser, types, searchText, sort, limit);

    const files = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      queries,
    );

    console.log({ files });
    return parseStringify(files);
  } catch (error) {
    handleError(error, "Failed to get files");
  }
};

export const renameFile = async ({
  fileId,
  name,
  extension,
  path,
}: RenameFileProps) => {
  const { databases } = await createAdminClient();

  try {
    const newName = `${name}.${extension}`;
    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      {
        name: newName,
      },
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

export const updateFileUsers = async ({
  fileId,
  emails,
  path,
}: UpdateFileUsersProps) => {
  const { databases } = await createAdminClient();

  try {
    const updatedFile = await databases.updateDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
      {
        users: emails,
      },
    );

    revalidatePath(path);
    return parseStringify(updatedFile);
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

export const deleteFile = async ({
  fileId,
  bucketFileId,
  path,
}: DeleteFileProps) => {
  const { databases, storage } = await createAdminClient();

  try {
    const deletedFile = await databases.deleteDocument(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      fileId,
    );

    if (deletedFile) {
      await storage.deleteFile(appwriteConfig.bucketId, bucketFileId);
    }

    revalidatePath(path);
    return parseStringify({ status: "success" });
  } catch (error) {
    handleError(error, "Failed to rename file");
  }
};

// ============================== TOTAL FILE SPACE USED
export async function getTotalSpaceUsed() {
  try {
    const { databases } = await createSessionClient();
    const currentUser = await getCurrentUser();
    if (!currentUser) throw new Error("User is not authenticated.");

    const files = await databases.listDocuments(
      appwriteConfig.databaseId,
      appwriteConfig.filesCollectionId,
      [Query.equal("owner", [currentUser.$id])],
    );

    const totalSpace = {
      image: { size: 0, latestDate: "" },
      document: { size: 0, latestDate: "" },
      video: { size: 0, latestDate: "" },
      audio: { size: 0, latestDate: "" },
      other: { size: 0, latestDate: "" },
      used: 0,
      all: 2 * 1024 * 1024 * 1024 /* 2GB available bucket storage */,
    };

    files.documents.forEach((file) => {
      const fileType = file.type as FileType;
      totalSpace[fileType].size += file.size;
      totalSpace.used += file.size;

      if (
        !totalSpace[fileType].latestDate ||
        new Date(file.$updatedAt) > new Date(totalSpace[fileType].latestDate)
      ) {
        totalSpace[fileType].latestDate = file.$updatedAt;
      }
    });

    return parseStringify(totalSpace);
  } catch (error) {
    handleError(error, "Error calculating total space used:, ");
  }
}

// "use server";

// import { createAdminClient, createSessionClient } from "@/lib/appwrite";
// import { appwriteConfig } from "@/lib/appwrite/config";
// import {
//   ID,
//   Models,
//   Query,
//   Permission,
//   Role,
//   Runtime,
// } from "node-appwrite";
// import { constructFileUrl, getFileType, parseStringify } from "@/lib/utils";
// import { revalidatePath } from "next/cache";
// import { getCurrentUser } from "@/lib/actions/user.actions";

// const handleError = (error: unknown, message: string) => {
//   console.error(message, error);
//   throw error;
// };

// /* =====================================================
//    UPLOAD FILE
// ===================================================== */
// export const uploadFile = async ({
//   file,
//   ownerId,
//   accountId,
//   path,
// }: UploadFileProps) => {
//   const { storage, databases } = await createAdminClient();

//   try {
//     // ✅ Use Runtime.InputFile for latest node-appwrite SDK
//     const inputFile = new Runtime.InputFile(file, file.name);

//     // ✅ Upload file to Appwrite bucket with permissions
//     const bucketFile = await storage.createFile(
//       appwriteConfig.bucketId,
//       ID.unique(),
//       inputFile,
//       [
//         Permission.read(Role.user(ownerId)),      // Only owner can read
//         Permission.update(Role.user(ownerId)),    // Only owner can update
//         Permission.delete(Role.user(ownerId)),    // Only owner can delete
//       ]
//     );

//     const { type, extension } = getFileType(bucketFile.name);

//     const fileDocument = {
//       type,
//       name: bucketFile.name,
//       url: constructFileUrl(bucketFile.$id),
//       extension,
//       size: bucketFile.sizeOriginal,
//       owner: ownerId,
//       accountId,
//       users: [],
//       bucketFileId: bucketFile.$id,
//     };

//     // ✅ Save file metadata in DB with same permissions
//     const newFile = await databases.createDocument(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       ID.unique(),
//       fileDocument,
//       [
//         Permission.read(Role.user(ownerId)),
//         Permission.update(Role.user(ownerId)),
//         Permission.delete(Role.user(ownerId)),
//       ]
//     );

//     revalidatePath(path);
//     return parseStringify(newFile);
//   } catch (error) {
//     handleError(error, "Failed to upload file");
//   }
// };

// /* =====================================================
//    QUERY BUILDER
// ===================================================== */
// const createQueries = (
//   currentUser: Models.Document & { email?: string },
//   types: string[],
//   searchText: string,
//   sort: string,
//   limit?: number
// ) => {
//   const queries = [
//     Query.or([
//       Query.equal("owner", [currentUser.$id]),
//       currentUser.email ? Query.contains("users", [currentUser.email]) : Query.equal("owner", [currentUser.$id]),
//     ]),
//   ];

//   if (types.length) queries.push(Query.equal("type", types));
//   if (searchText) queries.push(Query.contains("name", searchText));
//   if (limit) queries.push(Query.limit(limit));

//   if (sort) {
//     const [field, order] = sort.split("-");
//     queries.push(order === "asc" ? Query.orderAsc(field) : Query.orderDesc(field));
//   }

//   return queries;
// };

// /* =====================================================
//    GET FILES
// ===================================================== */
// export const getFiles = async ({
//   types = [],
//   searchText = "",
//   sort = "$createdAt-desc",
//   limit,
// }: GetFilesProps) => {
//   const { databases } = await createAdminClient();

//   try {
//     const currentUser = await getCurrentUser();
//     if (!currentUser) throw new Error("User not found");

//     const queries = createQueries(currentUser, types, searchText, sort, limit);

//     const files = await databases.listDocuments(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       queries
//     );

//     return parseStringify(files);
//   } catch (error) {
//     handleError(error, "Failed to get files");
//   }
// };

// /* =====================================================
//    RENAME FILE
// ===================================================== */
// export const renameFile = async ({
//   fileId,
//   name,
//   extension,
//   path,
// }: RenameFileProps) => {
//   const { databases } = await createAdminClient();

//   try {
//     const updatedFile = await databases.updateDocument(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       fileId,
//       { name: `${name}.${extension}` }
//     );

//     revalidatePath(path);
//     return parseStringify(updatedFile);
//   } catch (error) {
//     handleError(error, "Failed to rename file");
//   }
// };

// /* =====================================================
//    UPDATE FILE USERS
// ===================================================== */
// export const updateFileUsers = async ({
//   fileId,
//   emails,
//   path,
// }: UpdateFileUsersProps) => {
//   const { databases } = await createAdminClient();

//   try {
//     const updatedFile = await databases.updateDocument(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       fileId,
//       { users: emails }
//     );

//     revalidatePath(path);
//     return parseStringify(updatedFile);
//   } catch (error) {
//     handleError(error, "Failed to update file users");
//   }
// };

// /* =====================================================
//    DELETE FILE
// ===================================================== */
// export const deleteFile = async ({
//   fileId,
//   bucketFileId,
//   path,
// }: DeleteFileProps) => {
//   const { databases, storage } = await createAdminClient();

//   try {
//     await databases.deleteDocument(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       fileId
//     );

//     await storage.deleteFile(appwriteConfig.bucketId, bucketFileId);

//     revalidatePath(path);
//     return parseStringify({ status: "success" });
//   } catch (error) {
//     handleError(error, "Failed to delete file");
//   }
// };

// /* =====================================================
//    TOTAL SPACE USED
// ===================================================== */
// export async function getTotalSpaceUsed() {
//   try {
//     const { databases } = await createSessionClient();
//     const currentUser = await getCurrentUser();
//     if (!currentUser) throw new Error("User not authenticated");

//     const files = await databases.listDocuments(
//       appwriteConfig.databaseId,
//       appwriteConfig.filesCollectionId,
//       [Query.equal("owner", [currentUser.$id])]
//     );

//     const totalSpace = {
//       image: { size: 0, latestDate: "" },
//       document: { size: 0, latestDate: "" },
//       video: { size: 0, latestDate: "" },
//       audio: { size: 0, latestDate: "" },
//       other: { size: 0, latestDate: "" },
//       used: 0,
//       all: 2 * 1024 * 1024 * 1024, // 2GB total
//     };

//     files.documents.forEach((file) => {
//       const type = file.type as FileType;
//       totalSpace[type].size += file.size;
//       totalSpace.used += file.size;

//       if (!totalSpace[type].latestDate || new Date(file.$updatedAt) > new Date(totalSpace[type].latestDate)) {
//         totalSpace[type].latestDate = file.$updatedAt;
//       }
//     });

//     return parseStringify(totalSpace);
//   } catch (error) {
//     handleError(error, "Error calculating total space used");
//   }
// }
