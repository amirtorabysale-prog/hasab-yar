package com.example.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import com.example.data.model.AccountingRuleEntity
import com.example.data.model.AuditLogEntity
import com.example.data.model.BankAccountEntity
import com.example.data.model.BankTransactionEntity
import com.example.data.model.CategoryEntity
import com.example.data.model.CompanyEntity
import com.example.data.model.ContactEntity
import com.example.data.model.ContactType
import com.example.data.model.DocumentEntity
import com.example.data.model.DocumentSource
import com.example.data.model.DocumentStatus
import com.example.data.model.DocumentType
import com.example.data.model.TransactionEntity
import com.example.data.model.TransactionType

class Converters {
    @TypeConverter
    fun fromDocumentType(value: DocumentType): String = value.name

    @TypeConverter
    fun toDocumentType(value: String): DocumentType = DocumentType.valueOf(value)

    @TypeConverter
    fun fromDocumentStatus(value: DocumentStatus): String = value.name

    @TypeConverter
    fun toDocumentStatus(value: String): DocumentStatus = DocumentStatus.valueOf(value)

    @TypeConverter
    fun fromDocumentSource(value: DocumentSource): String = value.name

    @TypeConverter
    fun toDocumentSource(value: String): DocumentSource = DocumentSource.valueOf(value)

    @TypeConverter
    fun fromTransactionType(value: TransactionType): String = value.name

    @TypeConverter
    fun toTransactionType(value: String): TransactionType = TransactionType.valueOf(value)

    @TypeConverter
    fun fromContactType(value: ContactType): String = value.name

    @TypeConverter
    fun toContactType(value: String): ContactType = ContactType.valueOf(value)
}

@Database(
    entities = [
        CompanyEntity::class,
        ContactEntity::class,
        CategoryEntity::class,
        DocumentEntity::class,
        TransactionEntity::class,
        BankAccountEntity::class,
        BankTransactionEntity::class,
        AccountingRuleEntity::class,
        AuditLogEntity::class
    ],
    version = 1,
    exportSchema = false
)
@TypeConverters(Converters::class)
abstract class AppDatabase : RoomDatabase() {
    abstract fun appDao(): AppDao

    companion object {
        @Volatile
        private var INSTANCE: AppDatabase? = null

        fun getInstance(context: Context): AppDatabase {
            return INSTANCE ?: synchronized(this) {
                val instance = Room.databaseBuilder(
                    context.applicationContext,
                    AppDatabase::class.java,
                    "hesabyar_v2_db"
                )
                    .fallbackToDestructiveMigration()
                    .build()
                INSTANCE = instance
                instance
            }
        }
    }
}
