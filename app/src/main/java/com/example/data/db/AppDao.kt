package com.example.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Update
import com.example.data.model.AccountingRuleEntity
import com.example.data.model.AuditLogEntity
import com.example.data.model.BankAccountEntity
import com.example.data.model.BankTransactionEntity
import com.example.data.model.CategoryEntity
import com.example.data.model.CompanyEntity
import com.example.data.model.ContactEntity
import com.example.data.model.DocumentEntity
import com.example.data.model.TransactionEntity
import kotlinx.coroutines.flow.Flow

@Dao
interface AppDao {
    // Companies
    @Query("SELECT * FROM companies ORDER BY id ASC")
    fun getAllCompanies(): Flow<List<CompanyEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCompany(company: CompanyEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCompanies(companies: List<CompanyEntity>)

    // Contacts
    @Query("SELECT * FROM contacts WHERE companyId = :companyId ORDER BY name ASC")
    fun getContacts(companyId: Long): Flow<List<ContactEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertContact(contact: ContactEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertContacts(contacts: List<ContactEntity>)

    // Categories
    @Query("SELECT * FROM categories WHERE companyId = :companyId ORDER BY name ASC")
    fun getCategories(companyId: Long): Flow<List<CategoryEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertCategories(categories: List<CategoryEntity>)

    // Documents
    @Query("SELECT * FROM documents WHERE companyId = :companyId ORDER BY createdAt DESC")
    fun getDocuments(companyId: Long): Flow<List<DocumentEntity>>

    @Query("SELECT * FROM documents WHERE id = :id")
    suspend fun getDocumentById(id: Long): DocumentEntity?

    @Query("SELECT * FROM documents WHERE companyId = :companyId AND invoiceNumber = :invoiceNumber AND contactName = :contactName")
    suspend fun findDuplicates(companyId: Long, invoiceNumber: String, contactName: String): List<DocumentEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertDocument(document: DocumentEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertDocuments(documents: List<DocumentEntity>)

    @Update
    suspend fun updateDocument(document: DocumentEntity)

    @Delete
    suspend fun deleteDocument(document: DocumentEntity)

    // Transactions
    @Query("SELECT * FROM transactions WHERE companyId = :companyId ORDER BY createdAt DESC")
    fun getTransactions(companyId: Long): Flow<List<TransactionEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTransaction(transaction: TransactionEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertTransactions(transactions: List<TransactionEntity>)

    // Bank Accounts
    @Query("SELECT * FROM bank_accounts WHERE companyId = :companyId")
    fun getBankAccounts(companyId: Long): Flow<List<BankAccountEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertBankAccounts(accounts: List<BankAccountEntity>)

    // Bank Transactions
    @Query("SELECT * FROM bank_transactions WHERE companyId = :companyId ORDER BY id DESC")
    fun getBankTransactions(companyId: Long): Flow<List<BankTransactionEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertBankTransactions(transactions: List<BankTransactionEntity>)

    @Update
    suspend fun updateBankTransaction(transaction: BankTransactionEntity)

    // Accounting Rules
    @Query("SELECT * FROM accounting_rules WHERE companyId = :companyId")
    fun getRules(companyId: Long): Flow<List<AccountingRuleEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRule(rule: AccountingRuleEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertRules(rules: List<AccountingRuleEntity>)

    // Audit Logs
    @Query("SELECT * FROM audit_logs WHERE documentId = :documentId ORDER BY timestamp DESC")
    fun getAuditLogsForDocument(documentId: Long): Flow<List<AuditLogEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAuditLog(log: AuditLogEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAuditLogs(logs: List<AuditLogEntity>)
}
