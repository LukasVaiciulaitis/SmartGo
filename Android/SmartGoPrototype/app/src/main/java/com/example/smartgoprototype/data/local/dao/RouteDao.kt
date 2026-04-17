package com.example.smartgoprototype.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.example.smartgoprototype.data.local.entity.RouteEntity
import kotlinx.coroutines.flow.Flow

@Dao
abstract class RouteDao {

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsertAll(routes: List<RouteEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    abstract suspend fun upsert(route: RouteEntity)

    /**
     * Atomically replaces the entire cached route list.
     */
    @Transaction
    open suspend fun replaceAll(routes: List<RouteEntity>) {
        deleteAll()
        upsertAll(routes)
    }

    @Query("SELECT * FROM routes ORDER BY sortOrder ASC")
    abstract fun observeRoutes(): Flow<List<RouteEntity>>

    @Query("SELECT * FROM routes ORDER BY sortOrder ASC")
    abstract suspend fun getAll(): List<RouteEntity>

    @Query("SELECT * FROM routes WHERE id = :id")
    abstract suspend fun getById(id: String): RouteEntity?

    @Query("DELETE FROM routes")
    abstract suspend fun deleteAll()

    @Query("DELETE FROM routes WHERE id = :id")
    abstract suspend fun deleteById(id: String)

    @Query("UPDATE routes SET sortOrder = :order WHERE id = :id")
    abstract suspend fun updateSortOrder(id: String, order: Int)

    @Query("SELECT COALESCE(MAX(sortOrder), -1) + 1 FROM routes")
    abstract suspend fun nextSortOrder(): Int

    // Targeted mutations used for optimistic updates, cheaper than a full upsert.
    @Query("UPDATE routes SET userActive = :active WHERE id = :id")
    abstract suspend fun setUserActive(id: String, active: Boolean)

    @Query("UPDATE routes SET activeDaysJson = :daysJson WHERE id = :id")
    abstract suspend fun setActiveDays(id: String, daysJson: String)
}
